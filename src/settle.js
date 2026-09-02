// 分帳核心演算法（純函式，不碰資料庫，方便測試）
// Core splitting algorithms. Pure functions - no DB access, easy to test.

/**
 * 計算單筆明細每個人的分攤金額（整數元）。
 * 零頭規則：由「付款人」吸收；付款人若不在分攤名單，餘數依序每人 +1 補平。
 *
 * @param {number} amount 總金額（整數元）
 * @param {{memberId:number, weight:number}[]} participants 參與者與份數
 * @param {number} payerId 付款人 memberId
 * @returns {Map<number, number>} memberId -> 分攤金額
 */
export function computeShares(amount, participants, payerId) {
  if (!participants || participants.length === 0) return new Map();

  // 份數可能是小數（0.5 份），先放大成整數避免浮點誤差
  const w = participants.map((p) => Math.round((p.weight ?? 1) * 100));
  const totalW = w.reduce((s, x) => s + x, 0);
  if (totalW <= 0) throw new Error('總份數必須大於 0');

  const shares = new Map();
  const payerIdx = participants.findIndex((p) => p.memberId === payerId);
  let assigned = 0;

  for (let i = 0; i < participants.length; i++) {
    if (i === payerIdx) continue; // 付款人最後算，用來吃零頭
    const s = Math.floor((amount * w[i]) / totalW);
    shares.set(participants[i].memberId, s);
    assigned += s;
  }

  if (payerIdx >= 0) {
    // 付款人吸收全部零頭
    shares.set(payerId, amount - assigned);
  } else {
    // 付款人沒有參與分攤 -> 餘數依序灑給參與者，每人最多 +1
    let rest = amount - assigned;
    for (const p of participants) {
      if (rest <= 0) break;
      shares.set(p.memberId, shares.get(p.memberId) + 1);
      rest--;
    }
  }
  return shares;
}

/**
 * 計算每個人的淨額：墊付總額 − 分攤總額。
 * 正數 = 別人欠他；負數 = 他欠別人。全體加總必為 0。
 *
 * @param {number[]} memberIds
 * @param {{id:number, payerId:number, amount:number, participants:{memberId:number,weight:number}[]}[]} expenses
 * @returns {Map<number, number>}
 */
export function computeBalances(memberIds, expenses) {
  const bal = new Map(memberIds.map((id) => [id, 0]));
  const bump = (id, delta) => bal.set(id, (bal.get(id) ?? 0) + delta);

  for (const e of expenses) {
    bump(e.payerId, e.amount);
    for (const [mid, s] of computeShares(e.amount, e.participants, e.payerId)) {
      bump(mid, -s);
    }
  }
  return bal;
}

/**
 * 最少轉帳筆數（貪婪配對：欠最多的 <-> 被欠最多的）。
 * 保證筆數 <= 人數 − 1，且每個人所有轉帳的總和 === 他的淨額。
 *
 * @param {Map<number, number>} balances
 * @returns {{from:number, to:number, amount:number}[]}
 */
export function minimalTransfers(balances) {
  const creditors = []; // 被欠錢的
  const debtors = [];   // 欠錢的
  for (const [id, v] of balances) {
    if (v > 0) creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  // 金額大的先配，讓大額一次消掉
  creditors.sort((a, b) => b.v - a.v || a.id - b.id);
  debtors.sort((a, b) => b.v - a.v || a.id - b.id);

  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].v, creditors[j].v);
    if (amount > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].v -= amount;
    creditors[j].v -= amount;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return out;
}

/**
 * 單一成員的逐筆分攤明細（點成員時顯示的那一頁）。
 * net 一定等於這個人在 minimalTransfers 裡所有轉帳的總和。
 */
export function memberBreakdown(memberId, expenses) {
  const rows = [];
  let owed = 0;
  let paid = 0;

  for (const e of expenses) {
    const shares = computeShares(e.amount, e.participants, e.payerId);
    const joined = shares.has(memberId);
    const share = shares.get(memberId) ?? 0;
    if (e.payerId === memberId) paid += e.amount;
    owed += share;
    rows.push({ expenseId: e.id, joined, share, isPayer: e.payerId === memberId });
  }
  return { rows, owed, paid, net: paid - owed };
}

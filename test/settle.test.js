import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShares, computeBalances, minimalTransfers, memberBreakdown } from '../src/settle.js';

const evenly = (ids) => ids.map((memberId) => ({ memberId, weight: 1 }));

test('平均分攤除得盡', () => {
  const s = computeShares(1200, evenly([1, 2, 3, 4]), 1);
  assert.deepEqual([...s.values()], [300, 300, 300, 300]);
});

test('零頭由付款人吸收', () => {
  const s = computeShares(100, evenly([1, 2, 3]), 1);
  assert.equal(s.get(2), 33);
  assert.equal(s.get(3), 33);
  assert.equal(s.get(1), 34, '付款人多吃 1 元');
  assert.equal([...s.values()].reduce((a, b) => a + b), 100);
});

test('付款人不在分攤名單時，餘數依序每人 +1', () => {
  const s = computeShares(100, evenly([2, 3, 4]), 1); // 1 號墊錢但沒參與
  assert.equal(s.has(1), false);
  assert.deepEqual([...s.values()], [34, 33, 33]);
  assert.equal([...s.values()].reduce((a, b) => a + b), 100);
});

test('按份數不平均分攤，零頭仍由付款人吸收', () => {
  // 阿明(1) 2 份、小美(2) 1 份、小雅(3) 1 份 -> 共 4 份，1000/4 = 250
  const s = computeShares(1000, [
    { memberId: 1, weight: 2 },
    { memberId: 2, weight: 1 },
    { memberId: 3, weight: 1 },
  ], 1);
  assert.deepEqual([s.get(1), s.get(2), s.get(3)], [500, 250, 250]);

  // 除不盡：997 / 4 份
  const t = computeShares(997, [
    { memberId: 1, weight: 2 },
    { memberId: 2, weight: 1 },
    { memberId: 3, weight: 1 },
  ], 1);
  assert.equal([...t.values()].reduce((a, b) => a + b), 997);
  assert.equal(t.get(2), 249);
  assert.equal(t.get(3), 249);
  assert.equal(t.get(1), 499, '付款人吸收零頭');
});

test('支援 0.5 份（浮點份數不會產生誤差）', () => {
  const s = computeShares(100, [
    { memberId: 1, weight: 1 },
    { memberId: 2, weight: 0.5 },
  ], 1);
  assert.equal([...s.values()].reduce((a, b) => a + b), 100);
  assert.equal(s.get(2), 33);
  assert.equal(s.get(1), 67);
});

test('分攤金額總和永遠等於明細金額（隨機測試）', () => {
  for (let i = 0; i < 500; i++) {
    const n = 2 + Math.floor(Math.random() * 6);
    const ids = Array.from({ length: n }, (_, k) => k + 1);
    const parts = ids
      .filter(() => Math.random() > 0.2)
      .map((memberId) => ({ memberId, weight: 1 + Math.floor(Math.random() * 3) }));
    if (parts.length === 0) continue;
    const amount = 1 + Math.floor(Math.random() * 99999);
    const payer = ids[Math.floor(Math.random() * n)];
    const s = computeShares(amount, parts, payer);
    assert.equal([...s.values()].reduce((a, b) => a + b, 0), amount);
  }
});

/* -------------------------------- 結算 -------------------------------- */

// 對話中討論的例子：晚餐 2000(阿明付) / 車錢 800(小美付) / 飲料 200(阿華付，只有阿華小雅分)
const MEMBERS = [1, 2, 3, 4]; // 1阿明 2小美 3阿華 4小雅
const EXPENSES = [
  { id: 1, payerId: 1, amount: 2000, participants: evenly([1, 2, 3, 4]) },
  { id: 2, payerId: 2, amount: 800, participants: evenly([1, 2, 3, 4]) },
  { id: 3, payerId: 3, amount: 200, participants: evenly([3, 4]) },
];

test('淨額計算', () => {
  const b = computeBalances(MEMBERS, EXPENSES);
  assert.equal(b.get(1), 2000 - 500 - 200); //  +1300
  assert.equal(b.get(2), 800 - 500 - 200); //   +100
  assert.equal(b.get(3), 200 - 500 - 200 - 100); // -600
  assert.equal(b.get(4), 0 - 500 - 200 - 100); //  -800
  assert.equal([...b.values()].reduce((a, x) => a + x), 0, '全體淨額必為 0');
});

test('最少轉帳筆數 <= 人數 - 1，且金額對得起來', () => {
  const b = computeBalances(MEMBERS, EXPENSES);
  const ts = minimalTransfers(b);
  assert.ok(ts.length <= MEMBERS.length - 1, `${ts.length} 筆`);

  // 每個人的轉帳淨額 === 他的餘額
  for (const id of MEMBERS) {
    const net = ts.reduce((s, t) => s + (t.to === id ? t.amount : 0) - (t.from === id ? t.amount : 0), 0);
    assert.equal(net, b.get(id), `成員 ${id} 的轉帳總額對不上淨額`);
  }
});

test('成員逐筆明細的淨額 === 他在結算表上的總額', () => {
  const b = computeBalances(MEMBERS, EXPENSES);
  const ts = minimalTransfers(b);
  for (const id of MEMBERS) {
    const bd = memberBreakdown(id, EXPENSES);
    const fromSettle = ts.reduce(
      (s, t) => s + (t.to === id ? t.amount : 0) - (t.from === id ? t.amount : 0),
      0,
    );
    assert.equal(bd.net, fromSettle, `成員 ${id}`);
  }
});

test('隨機帳本：結算永遠收斂且金額守恆', () => {
  for (let round = 0; round < 200; round++) {
    const n = 2 + Math.floor(Math.random() * 7);
    const ids = Array.from({ length: n }, (_, k) => k + 1);
    const expenses = [];
    for (let i = 0; i < 1 + Math.floor(Math.random() * 12); i++) {
      const parts = ids
        .filter(() => Math.random() > 0.25)
        .map((memberId) => ({ memberId, weight: 1 + Math.floor(Math.random() * 3) }));
      if (!parts.length) continue;
      expenses.push({
        id: i,
        payerId: ids[Math.floor(Math.random() * n)],
        amount: 1 + Math.floor(Math.random() * 20000),
        participants: parts,
      });
    }
    const b = computeBalances(ids, expenses);
    assert.equal([...b.values()].reduce((a, x) => a + x, 0), 0);

    const ts = minimalTransfers(b);
    assert.ok(ts.length <= n - 1);
    for (const id of ids) {
      const net = ts.reduce((s, t) => s + (t.to === id ? t.amount : 0) - (t.from === id ? t.amount : 0), 0);
      assert.equal(net, b.get(id));
      assert.equal(memberBreakdown(id, expenses).net, b.get(id));
    }
  }
});

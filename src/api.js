// LIFF 前端呼叫的 REST API。全部用 POST，避免把 idToken 放進網址。
import * as store from './db.js';
import { computeShares, computeBalances, minimalTransfers } from './settle.js';

const LIFF_CHANNEL_ID = process.env.LIFF_CHANNEL_ID || '';
const DEV_USER = process.env.DEV_USER || '';

/* --------------------------- 身分驗證（LIFF ID Token） --------------------------- */

const tokenCache = new Map(); // idToken -> { profile, expiresAt }

export async function verifyIdToken(idToken) {
  // 本機開發：設 DEV_USER 就能跳過 LINE 驗證
  if (DEV_USER) return { sub: `dev-${idToken || DEV_USER}`, name: idToken || DEV_USER };
  if (!idToken) throw httpError(401, '缺少身分憑證');

  const hit = tokenCache.get(idToken);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;

  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: LIFF_CHANNEL_ID }),
  });
  if (!res.ok) {
    // LINE 會說明原因，最常見是 LIFF_CHANNEL_ID 填錯（要填 LIFF app 所屬 channel 的 Channel ID）
    const detail = await res.text().catch(() => '');
    console.error(
      `[auth] LINE 驗證失敗 ${res.status}：${detail}（目前 LIFF_CHANNEL_ID=${LIFF_CHANNEL_ID || '未設定'}）`,
    );
    throw httpError(401, '身分驗證失敗，請重新開啟');
  }
  const profile = await res.json(); // { sub, name, picture, exp, ... }
  tokenCache.set(idToken, { profile, expiresAt: Date.now() + 5 * 60 * 1000 });
  return profile;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 解析帳本與身分。me 可能是 null（還沒加入這本帳），不會自動建立成員 */
async function resolveMember(body) {
  const book = await store.getBook(body.bookId);
  if (!book) throw httpError(404, '找不到這本帳');
  const profile = await verifyIdToken(body.idToken);
  const me = await store.findMemberByLineUser(book.id, profile.sub);
  return { book, me: me ?? null, profile };
}

/** 需要已經是成員的操作用這個 */
async function requireMember(body) {
  const r = await resolveMember(body);
  if (!r.me) throw httpError(403, '請先加入這本帳');
  return r;
}

/* --------------------------------- 完整狀態 --------------------------------- */

async function buildState(book, meId) {
  const [members, expenses] = await Promise.all([
    store.listMembers(book.id),
    store.listExpenses(book.id),
  ]);
  const memberIds = members.map((m) => m.id);

  const enriched = expenses.map((e) => ({
    ...e,
    shares: Object.fromEntries(computeShares(e.amount, e.participants, e.payerId)),
  }));

  const balances = computeBalances(memberIds, expenses);
  const transfers = minimalTransfers(balances);

  const paid = new Map(memberIds.map((id) => [id, 0]));
  const owed = new Map(memberIds.map((id) => [id, 0]));
  for (const e of enriched) {
    paid.set(e.payerId, (paid.get(e.payerId) ?? 0) + e.amount);
    for (const [mid, s] of Object.entries(e.shares)) {
      owed.set(Number(mid), (owed.get(Number(mid)) ?? 0) + s);
    }
  }

  return {
    book: { id: book.id, name: book.name },
    meId,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      bankAccount: m.bank_account || '',
      linked: !!m.line_user_id,
      paid: paid.get(m.id) ?? 0,
      owed: owed.get(m.id) ?? 0,
      net: balances.get(m.id) ?? 0,
    })),
    expenses: enriched,
    transfers,
    total: expenses.reduce((s, e) => s + e.amount, 0),
  };
}

/* ---------------------------------- 驗證 ---------------------------------- */

function validateExpense(body, memberIds) {
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, '金額必須大於 0');
  if (amount > 100_000_000) throw httpError(400, '金額太大');
  if (!memberIds.includes(Number(body.payerId))) throw httpError(400, '付款人不在這本帳裡');

  const participants = (body.participants || [])
    .map((p) => ({ memberId: Number(p.memberId), weight: Number(p.weight ?? 1) }))
    .filter((p) => memberIds.includes(p.memberId) && p.weight > 0);
  if (participants.length === 0) throw httpError(400, '至少要有一位分攤者');

  const seen = new Set();
  for (const p of participants) {
    if (seen.has(p.memberId)) throw httpError(400, '分攤者重複');
    seen.add(p.memberId);
  }
  const note = String(body.note ?? '').slice(0, 60);
  return { amount, payerId: Number(body.payerId), participants, note };
}

/* ---------------------------------- 路由 ---------------------------------- */

export const routes = {
  // 前端啟動時取得 LIFF ID（不含任何機密）
  'GET /api/config': async () => ({ liffId: process.env.LIFF_ID || '', dev: !!DEV_USER }),

  // 沒有可用的 ?book=（直接開 LIFF、或舊連結指向已不存在的帳本）時，用聊天室重新對應。
  // 不在群組裡就不建帳本 —— 以前會開一本只有自己的個人帳本，使用者會誤以為進到群組的帳。
  'POST /api/book/by-group': async (body) => {
    await verifyIdToken(body.idToken);
    const groupId = String(body.groupId || '').trim();
    if (!groupId) throw httpError(400, 'NO_GROUP');
    const book = await store.getOrCreateBookByGroup(groupId);
    return { bookId: book.id };
  },

  // 只在開發模式可用：本機測試用的帳本
  'POST /api/dev/book': async () => {
    if (!DEV_USER) throw httpError(403, '非開發模式');
    const book = await store.getOrCreateBookByGroup('dev-local', '測試帳本');
    return { bookId: book.id };
  },

  // meId 為 null 代表這個人還沒加入，前端會顯示「你是誰？」讓他認領或新增
  'POST /api/state': async (body) => {
    const { book, me } = await resolveMember(body);
    return buildState(book, me?.id ?? null);
  },

  // 加入這本帳：認領一個別人幫忙加、還沒綁 LINE 的名字，或以新成員身分加入
  'POST /api/me/join': async (body) => {
    const { book, me, profile } = await resolveMember(body);
    if (me) return buildState(book, me.id); // 已經加入過，直接回狀態

    if (body.claimMemberId !== undefined && body.claimMemberId !== null) {
      const r = await store.claimMember(book.id, Number(body.claimMemberId), profile.sub);
      if (!r.ok) throw httpError(409, r.reason);
      return buildState(book, r.member.id);
    }

    const members = await store.listMembers(book.id);
    if (members.length >= 50) throw httpError(400, '成員數量已達上限');
    const name = String(body.name ?? '').trim().slice(0, 20) || profile.name || '新成員';
    const created = await store.createLineMember(book.id, profile.sub, name);
    const bank = String(body.bankAccount ?? '').trim().slice(0, 60);
    if (bank) await store.updateMember(created.id, { name, bankAccount: bank });
    return buildState(book, created.id);
  },

  // 更新自己的顯示名稱 / 銀行帳號
  'POST /api/me': async (body) => {
    const { book, me } = await requireMember(body);
    const name = String(body.name ?? me.name).trim().slice(0, 20);
    if (!name) throw httpError(400, '名稱不能空白');
    await store.updateMember(me.id, {
      name,
      bankAccount: String(body.bankAccount ?? '').trim().slice(0, 60),
    });
    return buildState(book, me.id);
  },

  // 手動新增一位還沒點進來的人
  'POST /api/members/add': async (body) => {
    const { book, me } = await requireMember(body);
    const name = String(body.name ?? '').trim().slice(0, 20);
    if (!name) throw httpError(400, '名稱不能空白');
    const members = await store.listMembers(book.id);
    if (members.length >= 50) throw httpError(400, '成員數量已達上限');
    await store.addPlainMember(book.id, name);
    return buildState(book, me.id);
  },

  'POST /api/members/delete': async (body) => {
    const { book, me } = await requireMember(body);
    const target = Number(body.memberId);
    if (target === me.id) throw httpError(400, '不能刪除自己');
    const r = await store.deleteMember(book.id, target);
    if (!r.ok) throw httpError(400, r.reason);
    return buildState(book, me.id);
  },

  'POST /api/expenses/create': async (body) => {
    const { book, me } = await requireMember(body);
    const members = await store.listMembers(book.id);
    const data = validateExpense(body, members.map((m) => m.id));
    await store.createExpense(book.id, data, me.name);
    return buildState(book, me.id);
  },

  'POST /api/expenses/update': async (body) => {
    const { book, me } = await requireMember(body);
    const members = await store.listMembers(book.id);
    const data = validateExpense(body, members.map((m) => m.id));
    const names = new Map(members.map((m) => [m.id, m.name]));
    const ok = await store.updateExpense(book.id, Number(body.id), data, me.name, names);
    if (!ok) throw httpError(404, '找不到這筆明細');
    return buildState(book, me.id);
  },

  'POST /api/expenses/delete': async (body) => {
    const { book, me } = await requireMember(body);
    const ok = await store.softDeleteExpense(book.id, Number(body.id), me.name);
    if (!ok) throw httpError(404, '找不到這筆明細');
    return buildState(book, me.id);
  },

  'POST /api/book/rename': async (body) => {
    const { book, me } = await requireMember(body);
    const name = String(body.name ?? '').trim().slice(0, 30);
    if (name) await store.renameBook(book.id, name);
    return buildState(await store.getBook(book.id), me.id);
  },
};

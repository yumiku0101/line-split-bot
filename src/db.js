// 資料存取層。SQL 是 SQLite 方言，本機和 Turso 共用（見 driver.js）。
import { randomBytes } from 'node:crypto';
import { initDriver, exec, all, get, run, batch } from './driver.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,
  line_group_id TEXT UNIQUE,
  name          TEXT NOT NULL DEFAULT '旅遊分帳',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      TEXT NOT NULL REFERENCES books(id),
  line_user_id TEXT,
  name         TEXT NOT NULL,
  bank_account TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(book_id, line_user_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT NOT NULL REFERENCES books(id),
  payer_id   INTEGER NOT NULL REFERENCES members(id),
  amount     INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  weight     REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS edit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  actor_name  TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_book ON expenses(book_id);
CREATE INDEX IF NOT EXISTS idx_members_book  ON members(book_id);
CREATE INDEX IF NOT EXISTS idx_shares_expense ON shares(expense_id);
`;

export async function initDb() {
  await initDriver();
  await exec(SCHEMA);
}

const now = () => new Date().toISOString();

/* ---------------------------------- 帳本 ---------------------------------- */

export async function getOrCreateBookByGroup(groupId, name = '旅遊分帳') {
  const found = await get('SELECT * FROM books WHERE line_group_id = ?', [groupId]);
  if (found) return found;
  const id = randomBytes(9).toString('base64url'); // 12 字元，不可猜測
  await run('INSERT INTO books (id, line_group_id, name, created_at) VALUES (?, ?, ?, ?)', [
    id, groupId, name, now(),
  ]);
  return get('SELECT * FROM books WHERE id = ?', [id]);
}

export function getBook(bookId) {
  return get('SELECT * FROM books WHERE id = ?', [bookId]);
}

export function renameBook(bookId, name) {
  return run('UPDATE books SET name = ? WHERE id = ?', [name, bookId]);
}

/* ---------------------------------- 成員 ---------------------------------- */

export function listMembers(bookId) {
  return all('SELECT * FROM members WHERE book_id = ? ORDER BY id', [bookId]);
}

/** LINE 使用者第一次點進 LIFF 就自動成為成員（名稱取自 LINE 暱稱） */
export async function upsertLineMember(bookId, lineUserId, displayName) {
  const found = await get('SELECT * FROM members WHERE book_id = ? AND line_user_id = ?', [
    bookId, lineUserId,
  ]);
  if (found) return found;
  const info = await run(
    'INSERT INTO members (book_id, line_user_id, name, created_at) VALUES (?, ?, ?, ?)',
    [bookId, lineUserId, displayName || '新成員', now()],
  );
  return get('SELECT * FROM members WHERE id = ?', [info.lastInsertRowid]);
}

/** 手動新增一位還沒點進來的人 */
export async function addPlainMember(bookId, name) {
  const info = await run(
    'INSERT INTO members (book_id, line_user_id, name, created_at) VALUES (?, NULL, ?, ?)',
    [bookId, name, now()],
  );
  return get('SELECT * FROM members WHERE id = ?', [info.lastInsertRowid]);
}

export async function updateMember(memberId, { name, bankAccount }) {
  const m = await get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!m) return null;
  await run('UPDATE members SET name = ?, bank_account = ? WHERE id = ?', [
    name ?? m.name,
    bankAccount === undefined ? m.bank_account : bankAccount || null,
    memberId,
  ]);
  return get('SELECT * FROM members WHERE id = ?', [memberId]);
}

/** 只有還沒出現在任何明細裡的成員才能刪除 */
export async function deleteMember(bookId, memberId) {
  const used = await get(
    `SELECT 1 AS x FROM expenses WHERE book_id = ? AND deleted_at IS NULL AND payer_id = ?
     UNION ALL
     SELECT 1 AS x FROM shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.book_id = ? AND e.deleted_at IS NULL AND s.member_id = ? LIMIT 1`,
    [bookId, memberId, bookId, memberId],
  );
  if (used) return { ok: false, reason: '這位成員已經出現在明細中，請先移除相關明細' };
  await run('DELETE FROM members WHERE id = ? AND book_id = ?', [memberId, bookId]);
  return { ok: true };
}

/* ---------------------------------- 明細 ---------------------------------- */

export async function listExpenses(bookId) {
  const rows = await all(
    'SELECT * FROM expenses WHERE book_id = ? AND deleted_at IS NULL ORDER BY id DESC',
    [bookId],
  );
  if (rows.length === 0) return [];

  // 一次撈完所有 shares / logs，避免 N+1 造成的網路往返
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const shareRows = await all(
    `SELECT expense_id, member_id, weight FROM shares WHERE expense_id IN (${ph})`,
    ids,
  );
  const logRows = await all(
    `SELECT expense_id, actor_name, description, created_at FROM edit_logs
      WHERE expense_id IN (${ph}) ORDER BY id`,
    ids,
  );

  const sharesBy = new Map(ids.map((id) => [id, []]));
  for (const s of shareRows) sharesBy.get(s.expense_id)?.push({ memberId: s.member_id, weight: s.weight });
  const logsBy = new Map(ids.map((id) => [id, []]));
  for (const l of logRows) logsBy.get(l.expense_id)?.push(l);

  return rows.map((r) => ({
    id: r.id,
    payerId: r.payer_id,
    amount: r.amount,
    note: r.note,
    createdAt: r.created_at,
    participants: sharesBy.get(r.id) ?? [],
    logs: logsBy.get(r.id) ?? [],
  }));
}

export async function createExpense(bookId, { payerId, amount, note, participants }, actorName) {
  const info = await run(
    'INSERT INTO expenses (book_id, payer_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [bookId, payerId, amount, note || '', now()],
  );
  const id = info.lastInsertRowid;
  await batch([
    ...participants.map((p) => [
      'INSERT INTO shares (expense_id, member_id, weight) VALUES (?, ?, ?)',
      [id, p.memberId, p.weight ?? 1],
    ]),
    logStatement(id, actorName, `新增這筆明細（${amount} 元）`),
  ]);
  return id;
}

export async function updateExpense(bookId, expenseId, next, actorName, memberNames) {
  const cur = await get(
    'SELECT * FROM expenses WHERE id = ? AND book_id = ? AND deleted_at IS NULL',
    [expenseId, bookId],
  );
  if (!cur) return null;
  const curShares = await all('SELECT member_id, weight FROM shares WHERE expense_id = ?', [expenseId]);
  const nameOf = (id) => memberNames.get(id) ?? '?';

  const diffs = [];
  if (next.note !== undefined && next.note !== cur.note) {
    diffs.push(`品項 ${cur.note || '(空白)'} → ${next.note || '(空白)'}`);
  }
  if (next.amount !== undefined && next.amount !== cur.amount) {
    diffs.push(`金額 ${cur.amount} → ${next.amount}`);
  }
  if (next.payerId !== undefined && next.payerId !== cur.payer_id) {
    diffs.push(`付款人 ${nameOf(cur.payer_id)} → ${nameOf(next.payerId)}`);
  }
  if (next.participants) {
    const before = new Map(curShares.map((s) => [s.member_id, s.weight]));
    const after = new Map(next.participants.map((p) => [p.memberId, p.weight ?? 1]));
    for (const [mid, w] of after) {
      if (!before.has(mid)) diffs.push(`加入 ${nameOf(mid)}`);
      else if (before.get(mid) !== w) diffs.push(`${nameOf(mid)} 份數 ${before.get(mid)} → ${w}`);
    }
    for (const mid of before.keys()) if (!after.has(mid)) diffs.push(`移除 ${nameOf(mid)}`);
  }

  const stmts = [
    ['UPDATE expenses SET payer_id = ?, amount = ?, note = ? WHERE id = ?',
      [next.payerId ?? cur.payer_id, next.amount ?? cur.amount, next.note ?? cur.note, expenseId]],
  ];
  if (next.participants) {
    stmts.push(['DELETE FROM shares WHERE expense_id = ?', [expenseId]]);
    for (const p of next.participants) {
      stmts.push(['INSERT INTO shares (expense_id, member_id, weight) VALUES (?, ?, ?)',
        [expenseId, p.memberId, p.weight ?? 1]]);
    }
  }
  if (diffs.length) stmts.push(logStatement(expenseId, actorName, diffs.join('、')));
  await batch(stmts);
  return expenseId;
}

export async function softDeleteExpense(bookId, expenseId, actorName) {
  const info = await run(
    'UPDATE expenses SET deleted_at = ? WHERE id = ? AND book_id = ? AND deleted_at IS NULL',
    [now(), expenseId, bookId],
  );
  if (info.changes) await batch([logStatement(expenseId, actorName, '刪除這筆明細')]);
  return info.changes > 0;
}

function logStatement(expenseId, actorName, description) {
  return [
    'INSERT INTO edit_logs (expense_id, actor_name, description, created_at) VALUES (?, ?, ?, ?)',
    [expenseId, actorName || '有人', description, now()],
  ];
}

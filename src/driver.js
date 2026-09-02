// 資料庫驅動層：本機用 Node 內建的 node:sqlite，線上用 Turso（libSQL）。
// 兩者都是 SQLite 方言，所以 db.js 裡的 SQL 一行都不用改。
//
// 有設 TURSO_DATABASE_URL -> 走 Turso（純 HTTP，不需要原生模組）
// 沒設                    -> 走本機檔案，零依賴

let impl = null;

/** 把 libSQL 回傳的 row 轉成單純物件（避免混入陣列索引屬性） */
const rowMapper = (columns) => (row) =>
  Object.fromEntries(columns.map((c, i) => [c, row[i]]));

export async function initDriver() {
  const url = process.env.TURSO_DATABASE_URL;

  if (url) {
    const { createClient } = await import('@libsql/client/web');
    const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

    impl = {
      kind: 'turso',
      async exec(sql) {
        await client.executeMultiple(sql);
      },
      async all(sql, args = []) {
        const r = await client.execute({ sql, args });
        return r.rows.map(rowMapper(r.columns));
      },
      async get(sql, args = []) {
        return (await impl.all(sql, args))[0];
      },
      async run(sql, args = []) {
        const r = await client.execute({ sql, args });
        return {
          changes: Number(r.rowsAffected ?? 0),
          lastInsertRowid: Number(r.lastInsertRowid ?? 0),
        };
      },
      async batch(statements) {
        if (statements.length === 0) return;
        await client.batch(
          statements.map(([sql, args = []]) => ({ sql, args })),
          'write',
        );
      },
    };
    console.log('[db] 使用 Turso');
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');

    const file = process.env.DB_PATH || './data/split.db';
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    impl = {
      kind: 'sqlite',
      async exec(sql) {
        db.exec(sql);
      },
      async all(sql, args = []) {
        return db.prepare(sql).all(...args);
      },
      async get(sql, args = []) {
        return db.prepare(sql).get(...args);
      },
      async run(sql, args = []) {
        const r = db.prepare(sql).run(...args);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try {
          for (const [sql, args = []] of statements) db.prepare(sql).run(...args);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    };
    console.log(`[db] 使用本機 SQLite：${file}`);
  }
  return impl;
}

const need = () => {
  if (!impl) throw new Error('資料庫尚未初始化，請先呼叫 initDriver()');
  return impl;
};

export const exec = (sql) => need().exec(sql);
export const all = (sql, args) => need().all(sql, args);
export const get = (sql, args) => need().get(sql, args);
export const run = (sql, args) => need().run(sql, args);
export const batch = (statements) => need().batch(statements);
export const driverKind = () => impl?.kind ?? 'none';

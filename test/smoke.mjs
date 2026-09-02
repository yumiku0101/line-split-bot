// 端對端煙霧測試：直接打 API，模擬 4 個人記帳 -> 結算。
// 用法： DEV_USER=x PORT=3111 node src/index.js  然後另開一個終端跑 node test/smoke.mjs
const BASE = process.env.BASE || 'http://localhost:3111';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error}`);
  return data;
}

const { bookId } = await post('/api/dev/book');
console.log('帳本：', bookId);

const PEOPLE = ['阿明', '小美', '阿華', '小雅'];
for (const name of PEOPLE) {
  await post('/api/me', { bookId, idToken: name, name, bankAccount: `玉山 ${name}帳號` });
}

let S = await post('/api/state', { bookId, idToken: '阿明' });
const id = (n) => S.members.find((m) => m.name === n).id;
console.log('成員：', S.members.map((m) => `${m.id}:${m.name}`).join('  '));

const all = () => S.members.map((m) => ({ memberId: m.id, weight: 1 }));

await post('/api/expenses/create', {
  bookId, idToken: '阿明',
  note: '晚餐', amount: 2000, payerId: id('阿明'), participants: all(),
});
await post('/api/expenses/create', {
  bookId, idToken: '小美',
  note: '車錢', amount: 800, payerId: id('小美'), participants: all(),
});
await post('/api/expenses/create', {
  bookId, idToken: '阿華',
  note: '飲料', amount: 200, payerId: id('阿華'),
  participants: [{ memberId: id('阿華'), weight: 1 }, { memberId: id('小雅'), weight: 1 }],
});
// 除不盡 + 不平均：阿明吃 2 份
S = await post('/api/expenses/create', {
  bookId, idToken: '小雅',
  note: '燒烤（阿明吃兩份）', amount: 1000, payerId: id('小雅'),
  participants: [
    { memberId: id('阿明'), weight: 2 },
    { memberId: id('小美'), weight: 1 },
    { memberId: id('阿華'), weight: 1 },
    { memberId: id('小雅'), weight: 1 },
  ],
});

console.log('\n--- 明細 ---');
for (const e of S.expenses) {
  const parts = Object.entries(e.shares).map(([m, v]) => `${S.members.find((x) => x.id === +m).name} ${v}`);
  console.log(`  ${e.note.padEnd(10)} ${String(e.amount).padStart(5)}  ${S.members.find((m) => m.id === e.payerId).name}付  →  ${parts.join(' / ')}`);
}

console.log('\n--- 每人淨額 ---');
for (const m of S.members) console.log(`  ${m.name}  墊付 ${m.paid}  分攤 ${m.owed}  淨額 ${m.net > 0 ? '+' : ''}${m.net}`);
console.log('  淨額總和 =', S.members.reduce((s, m) => s + m.net, 0), '（必須是 0）');

console.log('\n--- 結算（最少轉帳）---');
const nm = (i) => S.members.find((m) => m.id === i).name;
for (const t of S.transfers) console.log(`  ${nm(t.from)} → ${nm(t.to)}  ${t.amount}`);
console.log(`  共 ${S.transfers.length} 筆（上限 ${S.members.length - 1} 筆）`);

// 驗證：每個人的轉帳總額 === 淨額
for (const m of S.members) {
  const net = S.transfers.reduce((s, t) => s + (t.to === m.id ? t.amount : 0) - (t.from === m.id ? t.amount : 0), 0);
  if (net !== m.net) throw new Error(`${m.name} 轉帳總額 ${net} != 淨額 ${m.net}`);
}
console.log('  ✓ 每個人的轉帳總額都等於淨額');

// 編輯：晚餐 2000 -> 2400
const dinner = S.expenses.find((e) => e.note === '晚餐');
S = await post('/api/expenses/update', {
  bookId, idToken: '小美', id: dinner.id,
  note: '晚餐', amount: 2400, payerId: dinner.payerId, participants: dinner.participants,
});
console.log('\n--- 編輯後 ---');
const after = S.expenses.find((e) => e.id === dinner.id);
console.log('  修改紀錄：', after.logs.map((l) => `${l.actor_name} ${l.description}`).join(' ｜ '));
for (const t of S.transfers) console.log(`  ${nm(t.from)} → ${nm(t.to)}  ${t.amount}`);

// 刪除
S = await post('/api/expenses/delete', { bookId, idToken: '阿華', id: S.expenses.find((e) => e.note === '飲料').id });
console.log('\n刪除「飲料」後剩下', S.expenses.length, '筆，結算', S.transfers.length, '筆');

// 錯誤處理
for (const [desc, body] of [
  ['金額 0', { note: 'x', amount: 0, payerId: id('阿明'), participants: all() }],
  ['沒有分攤者', { note: 'x', amount: 100, payerId: id('阿明'), participants: [] }],
  ['分攤者重複', { note: 'x', amount: 100, payerId: id('阿明'), participants: [{ memberId: id('阿明') }, { memberId: id('阿明') }] }],
]) {
  try {
    await post('/api/expenses/create', { bookId, idToken: '阿明', ...body });
    throw new Error(`應該要被擋下來：${desc}`);
  } catch (e) {
    console.log(`  ✓ 擋下 ${desc}：${e.message.split('-> ')[1]}`);
  }
}

console.log('\n全部通過 ✅');

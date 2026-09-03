// 事後填銀行帳號的測試，重點是「不影響已經填好的資料」
const BASE = process.env.BASE || 'http://localhost:3111';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json() };
}
const ok = async (p, b) => {
  const r = await post(p, b);
  if (r.status !== 200) throw new Error(`${p} -> ${r.status} ${r.data.error}`);
  return r.data;
};
const assert = (c, m) => {
  if (!c) throw new Error('斷言失敗：' + m);
  console.log('  ✓ ' + m);
};
const bankOf = (S, name) => S.members.find((m) => m.name === name)?.bankAccount;

const { bookId } = await ok('/api/dev/book');

console.log('\n1. 阿明加入時就填了帳號，小美加入時沒填');
await ok('/api/me/join', { bookId, idToken: '阿明', name: '阿明', bankAccount: '玉山 111-222' });
let S = await ok('/api/me/join', { bookId, idToken: '小美', name: '小美' });
assert(bankOf(S, '阿明') === '玉山 111-222', '阿明的帳號已存在');
assert(bankOf(S, '小美') === '', '小美還沒填');

console.log('\n2. 小美事後補填');
S = await ok('/api/me', { bookId, idToken: '小美', name: '小美', bankAccount: '國泰 333-444' });
assert(bankOf(S, '小美') === '國泰 333-444', '小美補填成功');
assert(bankOf(S, '阿明') === '玉山 111-222', '阿明的帳號沒被動到');

console.log('\n3. 只改名字、不帶 bankAccount -> 原本的帳號要保留');
S = await ok('/api/me', { bookId, idToken: '小美', name: '小美美' });
assert(bankOf(S, '小美美') === '國泰 333-444', '沒帶 bankAccount 時帳號保留（改名前的隱患已修掉）');

console.log('\n4. 明確傳空字串才會清空');
S = await ok('/api/me', { bookId, idToken: '小美', name: '小美美', bankAccount: '' });
assert(bankOf(S, '小美美') === '', '傳空字串才清空');
S = await ok('/api/me', { bookId, idToken: '小美', name: '小美', bankAccount: '國泰 333-444' });
assert(bankOf(S, '小美') === '國泰 333-444', '再填回來也沒問題');

console.log('\n5. 幫「還沒認領」的成員填帳號');
S = await ok('/api/members/add', { bookId, idToken: '阿明', name: '阿華' });
const hua = S.members.find((m) => m.name === '阿華');
assert(hua.linked === false, '阿華是未認領狀態');
S = await ok('/api/members/update', {
  bookId, idToken: '阿明', memberId: hua.id, name: '阿華', bankAccount: '中信 555-666',
});
assert(bankOf(S, '阿華') === '中信 555-666', '阿明幫阿華填好了');

console.log('\n6. 阿華本人認領後，帳號沿用');
S = await ok('/api/me/join', { bookId, idToken: '阿華本人', claimMemberId: hua.id });
assert(bankOf(S, '阿華') === '中信 555-666', '認領後帳號還在');
assert(S.members.find((m) => m.id === hua.id).linked === true, '已綁定');

console.log('\n7. 不能改別人（已綁定）的資料');
const bad = await post('/api/members/update', {
  bookId, idToken: '阿明', memberId: hua.id, name: '亂改', bankAccount: '亂填',
});
assert(bad.status === 403, '被擋下：' + bad.data.error);
S = await ok('/api/state', { bookId, idToken: '阿明' });
assert(bankOf(S, '阿華') === '中信 555-666', '阿華的資料完全沒變');

console.log('\n8. 未加入的人不能改任何人');
const stranger = await post('/api/members/update', {
  bookId, idToken: '陌生人', memberId: hua.id, name: 'x',
});
assert(stranger.status === 403, '被擋下：' + stranger.data.error);

console.log('\n9. 最終狀態');
for (const m of S.members) console.log(`   ${m.name}　${m.bankAccount || '(未填)'}　${m.linked ? '已綁定' : '未認領'}`);

console.log('\n全部通過 ✅');

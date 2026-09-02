// 認領流程的端對端測試（需先啟動 DEV_USER 模式的伺服器）
const BASE = process.env.BASE || 'http://localhost:3111';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  return { status: res.status, data };
}
const ok = async (path, body) => {
  const r = await post(path, body);
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${r.data.error}`);
  return r.data;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error('斷言失敗：' + msg);
  console.log('  ✓ ' + msg);
};

const { bookId } = await ok('/api/dev/book');
console.log('帳本：', bookId);

console.log('\n1. 阿明第一次進來');
let S = await ok('/api/state', { bookId, idToken: '阿明' });
assert(S.meId === null, '還沒加入時 meId 是 null（前端會跳「你是誰？」）');
S = await ok('/api/me/join', { bookId, idToken: '阿明', name: '阿明', bankAccount: '玉山 111' });
assert(S.meId !== null, '以新成員加入後拿到 meId');
const idOf = (n) => S.members.find((m) => m.name === n).id;

console.log('\n2. 阿明幫小美、阿華先加名字');
S = await ok('/api/members/add', { bookId, idToken: '阿明', name: '小美' });
S = await ok('/api/members/add', { bookId, idToken: '阿明', name: '阿華' });
assert(S.members.length === 3, '共 3 位成員');
assert(S.members.filter((m) => !m.linked).length === 2, '其中 2 位是未認領狀態');

console.log('\n3. 阿明記一筆帳，三個人平分');
S = await ok('/api/expenses/create', {
  bookId, idToken: '阿明',
  note: '晚餐', amount: 1000, payerId: idOf('阿明'),
  participants: S.members.map((m) => ({ memberId: m.id, weight: 1 })),
});
const before = S.members.find((m) => m.name === '小美');
assert(before.owed === 333, '小美（未認領）已經被分攤了 333 元');

console.log('\n4. 小美本人進來，認領「小美」這個名字');
let S2 = await ok('/api/state', { bookId, idToken: '小美本人' });
assert(S2.meId === null, '小美還不是成員');
const claimable = S2.members.filter((m) => !m.linked).map((m) => m.name);
assert(claimable.includes('小美'), '看得到可認領的名字：' + claimable.join('、'));

S2 = await ok('/api/me/join', { bookId, idToken: '小美本人', claimMemberId: before.id });
assert(S2.meId === before.id, '認領後 meId 就是原本那個成員（沒有變成新的人）');
assert(S2.members.length === 3, '成員數仍是 3，沒有分裂成 4');
const after = S2.members.find((m) => m.id === before.id);
assert(after.linked === true, '小美現在是已綁定狀態');
assert(after.owed === 333, '原本記在她身上的 333 元完整保留');

console.log('\n5. 別人不能重複認領同一個名字');
const dup = await post('/api/me/join', { bookId, idToken: '路人甲', claimMemberId: before.id });
assert(dup.status === 409, '重複認領被擋下：' + dup.data.error);

console.log('\n6. 已加入的人再呼叫 join 不會出事');
const again = await ok('/api/me/join', { bookId, idToken: '小美本人', name: '亂改' });
assert(again.meId === before.id && again.members.length === 3, '直接回傳現況，不會重複建立');

console.log('\n7. 沒加入的人不能記帳');
const blocked = await post('/api/expenses/create', {
  bookId, idToken: '陌生人', note: 'x', amount: 100,
  payerId: idOf('阿明'), participants: [{ memberId: idOf('阿明') }],
});
assert(blocked.status === 403, '未加入者被擋：' + blocked.data.error);

console.log('\n8. 群組外開啟不再自動建帳本');
const nogroup = await post('/api/book/by-group', { idToken: '阿明', groupId: '' });
assert(nogroup.status === 400 && nogroup.data.error === 'NO_GROUP', '回 NO_GROUP，前端會顯示「請回群組」');

console.log('\n全部通過 ✅');

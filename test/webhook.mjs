// webhook 事件處理測試：一對一不建帳本、群組才建
import '../src/env.js';
import { initDb } from '../src/db.js';
import { handleEvents } from '../src/line.js';
import { all } from '../src/driver.js';

await initDb();
const count = async () => (await all('SELECT COUNT(*) AS n FROM books'))[0].n;
const assert = (c, m) => {
  if (!c) throw new Error('斷言失敗：' + m);
  console.log('  ✓ ' + m);
};

const before = await count();

console.log('\n1. 有人把 Yumiku 加好友（follow）');
await handleEvents([{ type: 'follow', replyToken: 'x', source: { userId: 'Utest0001' } }]);
assert((await count()) === before, '沒有建立帳本');

console.log('\n2. 有人私訊「分帳」');
await handleEvents([
  { type: 'message', replyToken: 'x', message: { type: 'text', text: '分帳' }, source: { userId: 'Utest0001' } },
]);
assert((await count()) === before, '一對一講什麼都不建帳本');

console.log('\n3. 私訊「結算」');
await handleEvents([
  { type: 'message', replyToken: 'x', message: { type: 'text', text: '結算' }, source: { userId: 'Utest0001' } },
]);
assert((await count()) === before, '一樣不建');

console.log('\n4. 群組裡打「分帳」-> 才建帳本');
await handleEvents([
  {
    type: 'message', replyToken: 'x',
    message: { type: 'text', text: '分帳' },
    source: { groupId: 'Ctestgroup0001', userId: 'Utest0001' },
  },
]);
assert((await count()) === before + 1, '群組才會建立帳本');

console.log('\n5. 同一個群組再打一次 -> 不會重複建');
await handleEvents([
  {
    type: 'message', replyToken: 'x',
    message: { type: 'text', text: '分帳' },
    source: { groupId: 'Ctestgroup0001', userId: 'Utest0002' },
  },
]);
assert((await count()) === before + 1, '沿用同一本');

console.log('\n6. 貼圖之類的訊息不理會');
await handleEvents([
  { type: 'message', replyToken: 'x', message: { type: 'sticker' }, source: { groupId: 'Cothergroup' } },
]);
assert((await count()) === before + 1, '沒有因為貼圖建帳本');

console.log('\n全部通過 ✅');

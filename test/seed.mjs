// 塞一堆假資料，用來測長列表的捲動
const BASE = process.env.BASE || 'http://localhost:3111';
const post = async (p, b) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b ?? {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p} ${r.status} ${d.error}`);
  return d;
};

const { bookId } = await post('/api/dev/book');
const PEOPLE = ['承翰', '蔡宗霖', '孫佑', '馬維君', '王之賢', '劉諒宇', '林世庭',
                '呂元薰', '黃信華', '楊孮銘', '蘇王尹', '陳威愷', '林柏龍', '謝志堯', '阿明'];
for (const name of PEOPLE) {
  await post('/api/me/join', { bookId, idToken: name, name, bankAccount: `700 郵局 ${name}` });
}
let S = await post('/api/state', { bookId, idToken: '阿明' });
const ids = S.members.map((m) => m.id);
const ITEMS = ['晚餐', '早餐', '車錢', '住宿', '門票', '飲料', '宵夜', '停車費', '加油', '伴手禮',
               '午餐', '船票', '纜車', '租車', '保險', '溫泉', '咖啡', '甜點', '水族館', '計程車',
               '便利商店', '藥妝', '行李寄放', '網卡', '機場接送'];
for (let i = 0; i < ITEMS.length; i++) {
  S = await post('/api/expenses/create', {
    bookId, idToken: '阿明',
    note: ITEMS[i],
    amount: 300 + Math.floor(Math.random() * 4000),
    payerId: ids[i % ids.length],
    participants: ids.map((id) => ({ memberId: id, weight: 1 })),
  });
}
console.log(`帳本 ${bookId}：${S.members.length} 人、${S.expenses.length} 筆明細`);
console.log(`http://localhost:3111/?book=${bookId}`);

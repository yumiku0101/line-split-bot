// LINE Messaging API webhook。直接打 REST，不需要 SDK。
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as store from './db.js';
import { computeBalances, minimalTransfers } from './settle.js';

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LIFF_ID = process.env.LIFF_ID || '';

/** 驗證 LINE 送來的簽章，防止偽造 webhook */
export function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const expected = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest();
  let got;
  try {
    got = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function reply(replyToken, messages) {
  if (!ACCESS_TOKEN) {
    console.warn('[line] 沒有設定 LINE_CHANNEL_ACCESS_TOKEN，跳過回覆');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('[line] 回覆失敗', res.status, await res.text());
}

const liffUrl = (bookId) => `https://liff.line.me/${LIFF_ID}?book=${bookId}`;

function openButton(book, text) {
  return {
    type: 'template',
    altText: `${book.name}｜點開分帳`,
    template: {
      type: 'buttons',
      title: book.name,
      text: text.slice(0, 60),
      actions: [{ type: 'uri', label: '開啟分帳', uri: liffUrl(book.id) }],
    },
  };
}

/** 群組裡打「結算」時直接在聊天室回覆結果，不用開網頁 */
async function settlementText(bookId) {
  const members = await store.listMembers(bookId);
  if (members.length === 0) return '這本帳還沒有任何成員。';
  const expenses = await store.listExpenses(bookId);
  if (expenses.length === 0) return '這本帳還沒有任何明細。';

  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const bankOf = new Map(members.map((m) => [m.id, m.bank_account]));
  const balances = computeBalances(
    members.map((m) => m.id),
    expenses,
  );
  const transfers = minimalTransfers(balances);
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  const head = `結算（${members.length} 人・${expenses.length} 筆・共 ${total.toLocaleString('zh-TW')} 元）`;
  if (transfers.length === 0) return `${head}\n\n已經平了，不用轉帳 🎉`;

  const lines = transfers.map((t) => {
    const bank = bankOf.get(t.to);
    const tail = bank ? `\n   └ ${bank}` : '';
    return `${nameOf.get(t.from)} → ${nameOf.get(t.to)}　${t.amount.toLocaleString('zh-TW')}${tail}`;
  });
  return `${head}\n\n${lines.join('\n')}`;
}

const OPEN_WORDS = ['分帳', '記帳', '開帳', '記一筆', 'split'];
const SETTLE_WORDS = ['結算', '算帳', '算一下', 'settle'];

export async function handleEvents(events) {
  for (const ev of events) {
    try {
      await handleEvent(ev);
    } catch (err) {
      console.error('[line] 處理事件失敗', err);
    }
  }
}

const ONE_ON_ONE_HINT =
  '分帳要在群組裡使用喔。\n\n' +
  '請把我加進你們的群組，然後在群組裡打「分帳」，\n' +
  '我會發一顆按鈕給大家點進去記帳。';

async function handleEvent(ev) {
  const groupKey = ev.source?.groupId || ev.source?.roomId || null;

  // 一對一聊天（加好友、私訊）不開帳本 —— 以前會為每個人開一本用不到的個人帳本
  if (!groupKey) {
    const isTalking = ev.type === 'follow' || (ev.type === 'message' && ev.message?.type === 'text');
    if (ev.replyToken && isTalking) {
      await reply(ev.replyToken, [{ type: 'text', text: ONE_ON_ONE_HINT }]);
    }
    return;
  }

  // 被加進群組 -> 開一本新帳，並送出入口
  if (ev.type === 'join') {
    const book = await store.getOrCreateBookByGroup(groupKey);
    if (ev.replyToken) {
      await reply(ev.replyToken, [openButton(book, '大家點進來輸入名字就可以開始記帳了')]);
    }
    return;
  }

  if (ev.type !== 'message' || ev.message?.type !== 'text') return;

  const text = ev.message.text.trim();
  const book = await store.getOrCreateBookByGroup(groupKey);

  if (SETTLE_WORDS.some((w) => text === w || text.startsWith(w))) {
    await reply(ev.replyToken, [
      { type: 'text', text: await settlementText(book.id) },
      openButton(book, '要看每個人的逐筆分攤就點進來'),
    ]);
    return;
  }

  if (OPEN_WORDS.some((w) => text === w || text.startsWith(w))) {
    await reply(ev.replyToken, [openButton(book, '新增明細、加成員、看結算')]);
    return;
  }

  // 「改名 沖繩五日遊」
  if (text.startsWith('改名')) {
    const name = text.slice(2).trim();
    if (name) {
      await store.renameBook(book.id, name);
      await reply(ev.replyToken, [{ type: 'text', text: `帳本已改名為「${name}」` }]);
    }
  }
}

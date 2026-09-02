// LIFF 前端。分攤計算直接沿用後端同一份 settle.js（由伺服器提供），
// 保證畫面上的預覽金額和後端算出來的完全一致。
import { computeShares } from './settle.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('zh-TW');

let bookId = new URLSearchParams(location.search).get('book');
let idToken = null;
let S = null; // 伺服器回來的完整狀態
let tab = 'expenses';

/* ------------------------------- 網路 ------------------------------- */

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, bookId, idToken }),
  });
  const data = await res.json().catch(() => ({ error: '伺服器沒有回應' }));
  if (!res.ok) throw new Error(data.error || '操作失敗');
  return data;
}

async function sync(path, body) {
  try {
    S = await api(path, body);
    render();
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

/* ------------------------------- 啟動 ------------------------------- */

async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const liffMode = !!(cfg.liffId && window.liff);
  let ctx = null;

  if (liffMode) {
    await liff.init({ liffId: cfg.liffId });
    if (!liff.isLoggedIn()) return liff.login({ redirectUri: location.href });
    idToken = liff.getIDToken();
    ctx = liff.getContext();
  } else {
    // 開發模式：用名字當身分，開不同分頁就能模擬不同人
    idToken = localStorage.getItem('devUser');
    if (!idToken) {
      idToken = prompt('開發模式：你是誰？（輸入名字）') || '測試員';
      localStorage.setItem('devUser', idToken);
    }
  }

  // 網址上的帳本優先。但聊天記錄裡的舊按鈕可能指向已不存在的帳本，
  // 所以載入失敗時不要直接報錯，改用目前的聊天室重新對應一本。
  let loaded = false;
  if (bookId) {
    try {
      S = await api('/api/state');
      loaded = true;
    } catch {
      bookId = null;
    }
  }

  if (!loaded) {
    const r = liffMode
      ? await api('/api/book/by-group', { groupId: ctx?.groupId || ctx?.roomId || '' })
      : await fetch('/api/dev/book', { method: 'POST' }).then((x) => x.json());
    bookId = r.bookId;
    history.replaceState(null, '', `?book=${bookId}`);
    S = await api('/api/state');
  }

  render();

  // 第一次進來 -> 請他確認名字（和選填帳號）
  if (!localStorage.getItem(`profiled:${bookId}`)) openProfileSheet(true);
}

/* ------------------------------- 畫面 ------------------------------- */

function render() {
  $('#bookName').textContent = S.book.name;
  $('#bookTotal').textContent = `${S.expenses.length} 筆・共 ${money(S.total)}`;
  $('#fab').hidden = tab !== 'expenses';
  for (const p of document.querySelectorAll('.panel')) p.classList.remove('on');
  $(`#p-${tab}`).classList.add('on');
  ({ expenses: renderExpenses, settle: renderSettle, members: renderMembers })[tab]();
}

const nameOf = (id) => S.members.find((m) => m.id === id)?.name ?? '?';

function renderExpenses() {
  const el = $('#p-expenses');
  if (S.expenses.length === 0) {
    el.innerHTML = '<div class="empty">還沒有任何明細。<br>點右下角「＋ 新增明細」開始。</div>';
    return;
  }
  el.innerHTML = S.expenses
    .map((e) => {
      const mine = e.shares[S.meId] ?? 0;
      const joined = String(S.meId) in e.shares;
      const uneven = e.participants.some((p) => p.weight !== 1);
      return `<div class="card" data-expense="${e.id}">
        <div class="row">
          <div class="grow">
            <div class="title truncate">${esc(e.note || '未命名')}</div>
            <div class="sub truncate">${esc(nameOf(e.payerId))} 墊付・${e.participants.length} 人分${uneven ? '（不平均）' : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="amt">${money(e.amount)}</div>
            <div class="mine">${joined ? `我 ${money(mine)}` : '未參與'}</div>
          </div>
        </div>
      </div>`;
    })
    .join('');
  el.querySelectorAll('[data-expense]').forEach((c) =>
    c.addEventListener('click', () => openExpenseSheet(Number(c.dataset.expense))),
  );
}

function renderSettle() {
  const el = $('#p-settle');
  if (S.transfers.length === 0) {
    el.innerHTML = `<div class="empty">${S.expenses.length ? '已經平了，不用轉帳 🎉' : '還沒有明細可以結算。'}</div>`;
    return;
  }
  const bankOf = (id) => S.members.find((m) => m.id === id)?.bankAccount || '';
  const cards = S.transfers
    .map((t) => {
      const bank = bankOf(t.to);
      return `<div class="card">
        <div class="transfer">
          <span class="grow truncate">${esc(nameOf(t.from))} <span class="arrow">→</span> <b>${esc(nameOf(t.to))}</b></span>
          <span class="amt">${money(t.amount)}</span>
        </div>
        ${
          bank
            ? `<div class="bank"><code class="grow truncate">${esc(bank)}</code>
                 <button class="chip-btn" data-copy="${esc(bank)}">複製帳號</button></div>`
            : `<div class="bank dim">${esc(nameOf(t.to))} 還沒填銀行帳號</div>`
        }
      </div>`;
    })
    .join('');

  el.innerHTML =
    `<div class="section-label">最少 ${S.transfers.length} 筆轉帳就能結清</div>${cards}
     <button class="btn ghost" id="copyAll" style="margin-top:14px">複製結算表貼回群組</button>`;

  el.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(b.dataset.copy, '已複製帳號')),
  );
  $('#copyAll').addEventListener('click', () => copy(settleText(), '已複製結算表'));
}

function settleText() {
  const lines = S.transfers.map((t) => {
    const bank = S.members.find((m) => m.id === t.to)?.bankAccount;
    return `${nameOf(t.from)} → ${nameOf(t.to)}　${money(t.amount)}${bank ? `\n   └ ${bank}` : ''}`;
  });
  return `${S.book.name}｜結算（${S.members.length} 人・${S.expenses.length} 筆・共 ${money(S.total)}）\n\n${lines.join('\n')}`;
}

function renderMembers() {
  const rows = S.members
    .map((m) => {
      const tagClass = m.net > 0 ? 'pos' : m.net < 0 ? 'neg' : 'dim';
      const tag = m.net > 0 ? `應收 ${money(m.net)}` : m.net < 0 ? `應付 ${money(-m.net)}` : '已結清';
      return `<div class="card" data-member="${m.id}">
        <div class="row">
          <div class="grow">
            <div class="title truncate">${esc(m.name)}${m.id === S.meId ? '（我）' : ''}</div>
            <div class="sub truncate">${m.bankAccount ? esc(m.bankAccount) : '尚未填銀行帳號'}</div>
          </div>
          <div class="amt ${tagClass}" style="font-size:13.5px">${tag}</div>
        </div>
      </div>`;
    })
    .join('');

  $('#p-members').innerHTML =
    rows +
    `<button class="btn ghost" id="addMember" style="margin-top:12px">＋ 新增一位還沒進來的人</button>
     <button class="btn ghost" id="editMe" style="margin-top:8px">修改我的名稱／銀行帳號</button>`;

  $('#p-members').querySelectorAll('[data-member]').forEach((c) =>
    c.addEventListener('click', () => openMemberSheet(Number(c.dataset.member))),
  );
  $('#addMember').addEventListener('click', async () => {
    const name = prompt('這個人的名字？');
    if (name?.trim()) await sync('/api/members/add', { name: name.trim() });
  });
  $('#editMe').addEventListener('click', () => openProfileSheet(false));
}

/* ------------------------------ 彈出視窗 ------------------------------ */

function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheetBg').hidden = false;
  $('#sheet').scrollTop = 0;
  $('#sheet').querySelector('.x')?.addEventListener('click', closeSheet);
}
function closeSheet() {
  $('#sheetBg').hidden = true;
  $('#sheet').innerHTML = '';
}
$('#sheetBg').addEventListener('click', (e) => {
  if (e.target.id === 'sheetBg') closeSheet();
});

function head(title) {
  return `<div class="sheet-head"><h2>${esc(title)}</h2><button class="x">✕</button></div>`;
}

/* --- 我的資料 --- */
function openProfileSheet(first) {
  const me = S.members.find((m) => m.id === S.meId);
  openSheet(`
    ${head(first ? '你是？' : '我的資料')}
    <label class="f">顯示名稱</label>
    <input type="text" id="pName" value="${esc(me?.name || '')}" maxlength="20" placeholder="大家看得懂的名字">
    <label class="f">銀行帳號（選填，別人轉帳給你時會看到）</label>
    <input type="text" id="pBank" value="${esc(me?.bankAccount || '')}" maxlength="60" placeholder="例：822 玉山 1234-567-890123">
    <button class="btn" id="pSave" style="margin-top:20px">${first ? '加入這本帳' : '儲存'}</button>
  `);
  $('#pSave').addEventListener('click', async () => {
    const name = $('#pName').value.trim();
    if (!name) return toast('名稱不能空白');
    await sync('/api/me', { name, bankAccount: $('#pBank').value.trim() });
    localStorage.setItem(`profiled:${bookId}`, '1');
    closeSheet();
  });
}

/* --- 新增／編輯明細 --- */
function openExpenseSheet(expenseId) {
  const ex = expenseId ? S.expenses.find((e) => e.id === expenseId) : null;
  const draft = {
    note: ex?.note ?? '',
    amount: ex?.amount ?? '',
    payerId: ex?.payerId ?? S.meId,
    // 預設全選
    weights: new Map(
      S.members.map((m) => [
        m.id,
        ex ? (ex.participants.find((p) => p.memberId === m.id)?.weight ?? 0) : 1,
      ]),
    ),
  };

  openSheet(`
    ${head(ex ? '編輯明細' : '新增明細')}
    <label class="f">金額</label>
    <input type="number" id="fAmount" class="amount-input" inputmode="numeric" min="1" step="1"
           value="${ex ? ex.amount : ''}" placeholder="0">
    <label class="f">品項</label>
    <input type="text" id="fNote" maxlength="60" value="${esc(draft.note)}" placeholder="晚餐、車錢、住宿…">
    <label class="f">誰付的錢</label>
    <div class="chips" id="fPayer"></div>
    <label class="f">誰要分攤　<button class="chip-btn" id="fAll">全選／全不選</button></label>
    <div class="plist" id="fParts"></div>
    <div class="sub" id="fHint" style="margin-top:8px"></div>
    <button class="btn" id="fSave" style="margin-top:20px">${ex ? '儲存修改' : '新增'}</button>
    ${ex ? '<button class="btn danger" id="fDel" style="margin-top:6px">刪除這筆明細</button>' : ''}
    ${
      ex?.logs?.length
        ? `<div class="log"><b>修改紀錄</b>${ex.logs
            .map((l) => `<div>✎ ${esc(l.actor_name)}　${new Date(l.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　${esc(l.description)}</div>`)
            .join('')}</div>`
        : ''
    }
  `);

  const parts = () =>
    S.members.filter((m) => draft.weights.get(m.id) > 0).map((m) => ({ memberId: m.id, weight: draft.weights.get(m.id) }));

  function paintPayer() {
    $('#fPayer').innerHTML = S.members
      .map((m) => `<button class="chip ${m.id === draft.payerId ? 'on' : ''}" data-p="${m.id}">${esc(m.name)}</button>`)
      .join('');
    $('#fPayer').querySelectorAll('[data-p]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.payerId = Number(b.dataset.p);
        paintPayer();
        paintParts();
      }),
    );
  }

  function paintParts() {
    const amount = Math.round(Number($('#fAmount').value)) || 0;
    const list = parts();
    const shares = list.length ? computeShares(amount, list, draft.payerId) : new Map();

    $('#fParts').innerHTML = S.members
      .map((m) => {
        const w = draft.weights.get(m.id);
        const on = w > 0;
        return `<div class="pitem ${on ? 'on' : ''}" data-m="${m.id}">
          <div class="box">${on ? '✓' : ''}</div>
          <div class="grow truncate">${esc(m.name)}${m.id === draft.payerId ? '　<span class="dim">（付款）</span>' : ''}</div>
          ${
            on
              ? `<div class="stepper" data-stop="1">
                   <button data-w="-1">−</button><b>${w} 份</b><button data-w="1">＋</button>
                 </div>`
              : ''
          }
          <div class="share-preview">${on ? money(shares.get(m.id) ?? 0) : ''}</div>
        </div>`;
      })
      .join('');

    $('#fParts').querySelectorAll('.pitem').forEach((row) => {
      const id = Number(row.dataset.m);
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-stop]')) return;
        draft.weights.set(id, draft.weights.get(id) > 0 ? 0 : 1);
        paintParts();
      });
      row.querySelectorAll('[data-w]').forEach((b) =>
        b.addEventListener('click', () => {
          const next = Math.max(1, Math.min(20, draft.weights.get(id) + Number(b.dataset.w)));
          draft.weights.set(id, next);
          paintParts();
        }),
      );
    });

    const uneven = list.some((p) => p.weight !== 1);
    const payerIn = list.some((p) => p.memberId === draft.payerId);
    const rounded = amount > 0 && list.length > 0 && amount % list.reduce((s, p) => s + p.weight, 0) !== 0;
    $('#fHint').textContent = !list.length
      ? '至少要選一位分攤者'
      : rounded
        ? payerIn
          ? `除不盡的零頭由付款人 ${nameOf(draft.payerId)} 吸收`
          : '付款人沒有參與分攤，零頭由分攤者依序各多付 1 元'
        : uneven
          ? '按份數分攤'
          : '平均分攤';
  }

  paintPayer();
  paintParts();
  $('#fAmount').addEventListener('input', paintParts);
  $('#fAll').addEventListener('click', (e) => {
    e.preventDefault();
    const allOn = S.members.every((m) => draft.weights.get(m.id) > 0);
    S.members.forEach((m) => draft.weights.set(m.id, allOn ? 0 : 1));
    paintParts();
  });

  $('#fSave').addEventListener('click', async () => {
    const amount = Math.round(Number($('#fAmount').value));
    if (!(amount > 0)) return toast('請輸入金額');
    const list = parts();
    if (!list.length) return toast('至少要選一位分攤者');
    const body = { amount, note: $('#fNote').value.trim(), payerId: draft.payerId, participants: list };
    await sync(ex ? '/api/expenses/update' : '/api/expenses/create', ex ? { ...body, id: ex.id } : body);
    closeSheet();
  });

  $('#fDel')?.addEventListener('click', async () => {
    if (!confirm('確定刪除這筆明細？')) return;
    await sync('/api/expenses/delete', { id: ex.id });
    closeSheet();
  });
}

/* --- 成員逐筆分攤 --- */
function openMemberSheet(memberId) {
  const m = S.members.find((x) => x.id === memberId);
  const rows = S.expenses
    .filter((e) => String(memberId) in e.shares || e.payerId === memberId)
    .map((e) => {
      const joined = String(memberId) in e.shares;
      const w = e.participants.reduce((s, p) => s + p.weight, 0);
      const how = e.participants.some((p) => p.weight !== 1) ? `${w} 份` : `${e.participants.length} 人`;
      return `<tr>
        <td class="truncate">${esc(e.note || '未命名')}${e.payerId === memberId ? '<br><span class="dim" style="font-size:11.5px">我墊付</span>' : ''}</td>
        <td class="n dim">${esc(nameOf(e.payerId))}<br>${money(e.amount)} / ${how}</td>
        <td class="n">${joined ? money(e.shares[memberId]) : '<span class="dim">—</span>'}</td>
      </tr>`;
    })
    .join('');

  const mine = S.transfers.filter((t) => t.from === memberId || t.to === memberId);
  const settleRows = mine
    .map((t) => {
      const other = t.from === memberId ? t.to : t.from;
      const bank = S.members.find((x) => x.id === other)?.bankAccount || '';
      const dir = t.from === memberId ? `轉給 ${nameOf(other)}` : `${nameOf(other)} 會轉給我`;
      return `<div class="card" style="margin:8px 0 0">
        <div class="transfer"><span class="grow truncate">${esc(dir)}</span><span class="amt">${money(t.amount)}</span></div>
        ${bank && t.from === memberId ? `<div class="bank"><code class="grow truncate">${esc(bank)}</code><button class="chip-btn" data-copy="${esc(bank)}">複製</button></div>` : ''}
      </div>`;
    })
    .join('');

  openSheet(`
    ${head(m.name + (m.id === S.meId ? '（我）' : ''))}
    ${m.bankAccount ? `<div class="bank" style="margin:0 0 8px"><code class="grow truncate">${esc(m.bankAccount)}</code><button class="chip-btn" data-copy="${esc(m.bankAccount)}">複製帳號</button></div>` : '<div class="sub">尚未填銀行帳號</div>'}

    <div class="section-label">逐筆分攤</div>
    <div class="card">
      <table class="bk">
        <tr><th>品項</th><th style="text-align:right">付款人 / 分法</th><th style="text-align:right">要付</th></tr>
        ${rows || '<tr><td colspan="3" class="dim">沒有相關明細</td></tr>'}
        <tr class="sum"><td colspan="2">分攤合計</td><td class="n">${money(m.owed)}</td></tr>
        <tr><td colspan="2" class="dim">墊付合計</td><td class="n dim">−${money(m.paid)}</td></tr>
        <tr class="sum"><td colspan="2">${m.net >= 0 ? '應收' : '應付'}淨額</td>
            <td class="n ${m.net > 0 ? 'pos' : m.net < 0 ? 'neg' : ''}">${money(Math.abs(m.net))}</td></tr>
      </table>
    </div>

    <div class="section-label">結算</div>
    ${settleRows || '<div class="card dim">已經結清</div>'}

    ${
      m.id !== S.meId && m.owed === 0 && m.paid === 0
        ? '<button class="btn danger" id="delM" style="margin-top:18px">從這本帳移除</button>'
        : ''
    }
  `);

  $('#sheet').querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(b.dataset.copy, '已複製')),
  );
  $('#delM')?.addEventListener('click', async () => {
    if (!confirm(`把 ${m.name} 從這本帳移除？`)) return;
    await sync('/api/members/delete', { memberId });
    closeSheet();
  });
}

/* ------------------------------- 小工具 ------------------------------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  }),
);
$('#fab').addEventListener('click', () => openExpenseSheet(null));

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div class="empty">啟動失敗：${esc(e.message)}</div>`;
});

# LINE 旅遊分帳機器人

一次性旅遊分帳。記完帳按「結算」，直接算出**最少轉帳筆數**，不用逐筆打勾。

- **本機零依賴** — 只用 Node 內建模組（`node:sqlite` / `node:http` / `node:crypto`）
- 線上部署才需要 `@libsql/client`（連 Turso 用，純 JS 無原生模組）
- 需要 **Node 22.5 以上**（實測 24.13）

## 功能

| | |
|---|---|
| 自助加入 | 點進 LIFF 自動帶入 LINE 暱稱，確認名稱即加入；銀行帳號選填 |
| 記帳 | 金額、品項、付款人、分攤者（**預設全選**）、份數（不平均分攤） |
| 零頭 | 除不盡的餘數**由付款人吸收**；付款人未參與分攤時，餘數由分攤者依序各多付 1 元 |
| 編輯 | 明細可改金額／品項／付款人／分攤者，並保留修改紀錄；刪除為軟刪除 |
| 結算 | 貪婪配對算出最少轉帳筆數（≤ 人數−1），附收款人帳號一鍵複製 |
| 逐筆分攤 | 點成員看他在每個品項各要付多少，合計必等於他在結算表上的金額 |

## 本機開發

```bash
cd line-split-bot
cp .env.example .env      # 把 DEV_USER 那行取消註解
npm run dev
```

打開 <http://localhost:3000>，輸入一個名字當身分。**開不同瀏覽器分頁、用不同名字，就能模擬多人。**

```bash
npm test                  # 分攤／結算演算法（含隨機測試）
node test/smoke.mjs       # 端對端 API 測試（需先啟動伺服器）
```

## 接上 LINE

1. **LINE Developers Console** → 建立 Provider → 建立 **Messaging API** channel
2. Basic settings → 記下 **Channel secret** → `LINE_CHANNEL_SECRET`
3. Messaging API → 發行 **Channel access token (long-lived)** → `LINE_CHANNEL_ACCESS_TOKEN`
4. Messaging API → 關掉「自動回覆訊息」與「加入好友的歡迎訊息」，打開 **Webhook**
5. **另外建一個 LINE Login channel**（LIFF 不能建在 Messaging API channel 底下）
   - Basic settings → Linked LINE Official Account 選第 1 步建的那個帳號
   - LIFF → Add → Size 選 **Full**、Endpoint URL 填 `https://你的網域/`、
     Scopes 勾 `profile` + `openid`、Bot link feature 開 **On (Aggressive)**
   - 取得 **LIFF ID** → `LIFF_ID`
   - **這個 Login channel** 的 Channel ID → `LIFF_CHANNEL_ID`（不是 Messaging API 的 ID）
6. Webhook URL 填 `https://你的網域/webhook`，按 Verify
7. 把 bot 加進 LINE 群組

> 本機測試 webhook 可用 `ngrok http 3000`，把 https 網址填進 Webhook URL 和 LIFF Endpoint URL。

### 群組指令

| 打什麼 | 會發生什麼 |
|---|---|
| `分帳` / `記帳` | 回一顆按鈕，點開 LIFF |
| `結算` | 直接在聊天室回覆結算表（含帳號） |
| `改名 沖繩五日遊` | 改帳本名稱 |

## 部署（Render 免費方案 + Turso 免費資料庫）

Render 免費方案**沒有持久磁碟**，SQLite 檔會在每次重啟／重新部署時被清空，
所以線上改用 [Turso](https://turso.tech)（SQLite 相容的雲端資料庫，免費方案 5GB）。
程式會自動判斷：有設 `TURSO_DATABASE_URL` 就走 Turso，沒設就走本機檔案。

1. **Turso** → 註冊（免信用卡）→ 建立 database → 取得 **Database URL** 與 **Auth token**
2. **GitHub** → 建立一個 repo → 把這個資料夾推上去
3. **Render** → New → **Blueprint** → 選那個 repo（會自動讀取 `render.yaml`）
   → 依序填入 6 個環境變數：
   `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、
   `LIFF_ID`、`LIFF_CHANNEL_ID`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`
4. 部署完成後拿到固定網址 `https://xxx.onrender.com`，回 LINE console 更新兩個地方：
   - Messaging API channel → Webhook URL → `https://xxx.onrender.com/webhook`
   - LINE Login channel → LIFF → Endpoint URL → `https://xxx.onrender.com/`

> **免費方案會休眠**：閒置 15 分鐘後服務會停，下一個請求要等約 30–60 秒冷啟動。
> 群組裡第一則訊息可能沒反應，再打一次就好。要避免的話可以用外部排程
> （例如 cron-job.org）每 10 分鐘打一次 `/healthz`。

## 安全性

- Webhook 用 HMAC-SHA256 驗簽（`verifySignature`），偽造請求會被擋掉
- LIFF 前端每次呼叫都帶 ID token，後端向 LINE 的 `/oauth2/v2.1/verify` 驗證，快取 5 分鐘
- 帳本 ID 是 12 字元亂數，知道網址的人才進得去（適合朋友群，不適合放公開場合）
- `.env` 已列在 `.gitignore`，**不要把 Channel secret 或 access token 提交進版控**

## 結構

```
src/settle.js   分攤與結算演算法（純函式，前後端共用同一份）
src/driver.js   資料庫驅動：本機 node:sqlite / 線上 Turso，同一套 SQL
src/db.js       資料存取層
src/api.js      LIFF 用的 REST API + LINE 身分驗證
src/line.js     LINE webhook
src/index.js    HTTP 伺服器
public/         LIFF 前端（原生 JS，無框架）
```

前端的 `import './settle.js'` 由伺服器直接提供 `src/settle.js`，所以**畫面上的分攤預覽和後端實際入帳保證一致**。

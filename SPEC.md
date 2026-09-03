# Future Me（寫給未來的自己）— 規格書

> 版本 0.2 · 2026-09-03（v0.1 為 2026-08-15 的 skill + shell 腳本版，已由本版取代）
> 一個完全離線的「未來信」桌面 App。信在 App 裡寫、加密存在本機、到期由 App 自己彈出來。
> 沒有伺服器、沒有帳號、沒有網路連線。Claude 不參與寫信，也讀不到任何一封信。

---

## 一、設計決策（已確認）

| 項目 | 決定 |
|---|---|
| 形式 | Electron 桌面 App（純 HTML/CSS/JS 介面，不用框架） |
| 加密 | 單一主密碼；scrypt 派生金鑰 + AES-256-GCM；寫信封存與拆信都要輸入 |
| 排程精度 | 日期 + 時間 |
| 到期呈現 | 信封／信紙兩層：信封（日期、標題、引言）無條件彈出；信紙（正文）輸入密碼才展開 |
| 儲存位置 | `~/Future Me/` |
| 常駐方式 | App 常駐選單列，每 30 秒檢查；由 launchd LaunchAgent 看管：登入自動啟動、非正常結束 10 秒內重啟 |

### 為什麼從 skill 改成 App

v0.1 的寫信流程是「講給 Claude 聽、Claude 幫你封存」，所以 Claude 一定會看到信的內容。
改成 App 之後，你自己在視窗裡打字，內容從輸入到加密都只經過 App 的主程序，Claude 從頭到尾不在場。

---

## 二、密碼策略

### 單一主密碼

整個信箱共用一組主密碼。三年後的你不可能記得三年前為某封信設的專屬密碼；
共用一組，每次寫信、讀信都在複習它。忘記的代價是全部信件永久打不開，所以：

1. **密碼提示（hint）**：設定時必填，明文存在 `vault.json`，每次密碼框都會顯示。
2. **canary**：`vault.json` 裡有一段用主密碼加密的固定字串。輸入密碼先驗它，錯了立刻說「密碼不對」，不會把信解成亂碼讓你以為信壞了。
3. **更換主密碼**：設定頁可用舊密碼把所有信重新加密成新密碼。

### 金鑰只在記憶體

密碼在視窗裡輸入 → 經 IPC 送到主程序 → 派生金鑰 → 密碼立即丟棄。
金鑰只存在主程序記憶體，預設 15 分鐘沒用就清除（可調），結束 App 時也清除。
密碼、金鑰、解密後的正文都不會寫入任何檔案。

---

## 三、檔案結構

```
~/Future Me/                      ← 資料家（不進 git、不進雲端）
├── config.json                   ← 設定
├── vault.json                    ← 主密碼驗證：salt、scrypt 參數、canary、hint
├── index.json                    ← 信封層（明文）
└── letters/
    ├── a3f2c9.sealed             ← 信紙密文：{ iv, tag, data }（base64）
    └── a3f2c9.reflection.sealed  ← 讀完後寫的反思（同樣加密，可能不存在）

專案（原始碼）
├── src/main/main.js              視窗、選單列圖示、通知、生命週期
├── src/main/store.js             讀寫 config / vault / index / letters
├── src/main/crypto.js            scrypt + AES-256-GCM、canary
├── src/main/session.js           金鑰持有與自動上鎖
├── src/main/scheduler.js         到期檢查、補送、每日提醒
├── src/main/ipc.js               renderer ↔ main 的所有橋接
├── src/main/watchdog.js          launchd LaunchAgent 註冊、交棒、卸載
├── src/main/log.js               事件記錄檔
├── src/preload.js                contextBridge 白名單 API
├── src/renderer/                 index.html / app.js / style.css
├── test/                         crypto、store、scheduler 單元測試；cdp.js 為除錯工具
├── scripts-make-icons.js         產生選單列圖示（心形天燈線稿 template）
└── scripts-make-app-icon.js      程式繪製的手繪風 App 圖示（紫夜、信封、心形封蠟）→ assets/icon.png
```

### `index.json` 單筆

```json
{
  "id": "a3f2c9",
  "title": "給準備出書的自己",
  "epigraph": "關於那個你以為過不去的坎",
  "paper": "night",
  "created_at": "2026-09-03T01:45:21.540Z",
  "deliver_at": "2027-03-01T01:00:00.000Z",
  "status": "sealed | delivered | opened",
  "delivered_at": null,
  "opened_at": null,
  "reflected_at": null,
  "last_nagged": null
}
```

明文欄位只有日期、標題、引言、狀態。正文一個字都不在裡面；標題與引言可留空。

---

## 四、核心流程

### 首次設定
建立資料夾 → 設主密碼（輸兩次）+ 必填提示 → 產生 salt、加密 canary 寫入 `vault.json` → 詢問登入自動開啟。

### 寫信（封存）
1. 送達日期＋時間（預設 09:00；快捷鍵半年／一年／三年／五年）、標題、信封引言、正文。
   每次進入寫信頁隨機出現一款信紙（橫線信紙、夜空、櫻花、舊信箋），可按「換一張信紙」重抽；
   封存時把信紙代號記在 `index.json` 的 `paper` 欄位，拆信時用同一款信紙顯示。
2. 側欄有六個引導問題，純提示文字。**App 不代筆、不潤飾、不生成範例。**
3. 草稿只在記憶體；關視窗前若有未封存內容會警告。
4. 按「封存」→ 密碼框 → 驗 canary → 加密正文 → 寫 `letters/<id>.sealed` + `index.json`。

### 到期送達
1. 每 30 秒掃 `index.json`：`status == sealed && deliver_at <= now` → 改 `delivered`，發 macOS 通知，彈出信封視窗（置頂 4 秒後恢復一般視窗）。
2. 「拆開信紙」→ 密碼框 → 解密 → 同一視窗展開正文 → `opened`。正文只存在記憶體與該視窗，關閉即清除。
3. 條件是 `<=` 而非 `==`：關機、睡眠期間錯過的信，App 啟動時、螢幕解鎖時、睡眠喚醒時都會立刻補送。
4. 已送達未拆封：信箱有「待拆封」區、Dock 與選單列顯示數量，每天 `nag_time` 再通知一次（`last_nagged` 記當天，當天不重複）。

### 讀完之後
- 收好：關閉視窗，信保留在「已拆封」。
- 寫下反思：`letters:reflect` 用同一把金鑰加密文字，存成 `letters/<id>.reflection.sealed`，`index.json` 記 `reflected_at`（明文只有時間）。再讀信時 `letters:open` 一併解密回傳，顯示在正文下方；可再編輯。
- 刪除：二次確認 + 密碼，信與反思一起刪除（`letters:cancel`，任何狀態皆可）。

### 其他
- 信箱列表：待拆封／在途／已拆封三區，只顯示信封層；底圖為 `src/renderer/img/inbox-bg.jpg`。
- 撤回：未送達的信可撤回，需密碼 + 二次確認，檔案直接刪除。
- 更換主密碼：先用舊金鑰解開全部（確認都沒問題）→ 用新金鑰全部重寫 → 寫新 `vault.json`。
- 「打開資料夾」：方便 Time Machine 備份或搬家。

---

## 五、加密細節

- 金鑰派生：`scrypt(passphrase, salt[16 bytes], N=2^17, r=8, p=1)` → 32 bytes
- 對稱加密：`aes-256-gcm`，每封信獨立隨機 12-byte IV，16-byte auth tag
- canary：`"future-letter-ok"` 的密文；GCM 驗證失敗即視為密碼錯誤
- 全部使用 Node 內建 `crypto`，不依賴 openssl 指令或第三方套件
- renderer 以 `contextIsolation + sandbox` 執行，CSP 禁止任何網路連線（`connect-src 'none'`）

---

## 六、已知限制

1. 忘記主密碼 = 所有信永久打不開。沒有後門。
2. App 必須在執行中才會準時彈出。launchd 會在當機或被 kill 後自動重啟；使用者明確「結束」（需確認）後要到下次登入或重新打開才會再跑，重開時立刻補送。事件記錄在 `~/Library/Logs/Future Me/app.log`。
3. 未簽章 App 第一次要右鍵 → 打開。
4. 「登入時自動開啟」只在打包後的 App 生效，`npm start` 開發模式不會註冊。
5. 更換主密碼是逐封重寫，中途強制結束 App 可能造成部分信件用新密碼、`vault.json` 仍是舊的。更換時請不要關閉 App。

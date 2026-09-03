'use strict';
// 簡單的記錄檔：~/Library/Logs/Future Me/app.log（只記事件，不記任何信件內容）
const fs = require('fs');
const path = require('path');
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'app.log');
    // 超過 1MB 就換檔
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old');
    } catch {}
  } catch {
    file = null;
  }
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (file) {
    try {
      fs.appendFileSync(file, line);
    } catch {}
  }
  if (!process.env.FUTURE_ME_LAUNCHD) process.stdout.write(line);
}

module.exports = { init, log };

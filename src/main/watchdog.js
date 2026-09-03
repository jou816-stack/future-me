'use strict';
// launchd 看管：讓 App 由 macOS 的 launchd 啟動與看顧。
//  - RunAtLoad：登入時自動啟動
//  - KeepAlive.SuccessfulExit=false：非正常結束（當機、被 kill）就在 10 秒內重啟；正常「結束」不重啟
// App 若不是被 launchd 啟動的（例如雙擊圖示），會先把自己註冊進 launchd，交棒給 launchd 啟動的那份，然後自己退出。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { log } = require('./log');

const LABEL = 'com.claire.future-me';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;

function plistXml(exe, runAtLoad) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(exe)}</string></array>
  <key>RunAtLoad</key><${runAtLoad ? 'true' : 'false'}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key><dict><key>FUTURE_ME_LAUNCHD</key><string>1</string></dict>
</dict>
</plist>
`;
}

function launchctl(...args) {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function isUnderLaunchd() {
  return process.env.FUTURE_ME_LAUNCHD === '1';
}

// 確保 plist 是最新的（路徑或 RunAtLoad 變了就重寫）。回傳是否有改動。
function writePlist(runAtLoad) {
  const xml = plistXml(process.execPath, runAtLoad);
  let current = null;
  try {
    current = fs.readFileSync(PLIST, 'utf8');
  } catch {}
  if (current === xml) return false;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, xml, { mode: 0o644 });
  return true;
}

// 啟動時呼叫。回傳 true 代表「已交棒給 launchd，自己該退出」。
function ensure({ runAtLoad, releaseLock }) {
  try {
    const changed = writePlist(runAtLoad);
    if (isUnderLaunchd()) {
      log('watchdog: running under launchd', changed ? '(plist updated)' : '');
      return false;
    }
    // 不是 launchd 啟動的 → 註冊並交棒
    const boot = launchctl('bootstrap', DOMAIN, PLIST);
    if (boot.code !== 0 && !/already|37|5:/.test(boot.out)) {
      log('watchdog: bootstrap failed, running standalone', boot.out.trim());
      return false;
    }
    if (changed && boot.code !== 0) {
      // 已載入但 plist 改了 → 重新載入（bootout 會先結束舊的 agent 實例，此時沒有實例在跑）
      launchctl('bootout', `${DOMAIN}/${LABEL}`);
      launchctl('bootstrap', DOMAIN, PLIST);
    }
    if (releaseLock) releaseLock();
    const kick = launchctl('kickstart', `${DOMAIN}/${LABEL}`);
    if (kick.code !== 0) {
      log('watchdog: kickstart failed, running standalone', kick.out.trim());
      return false;
    }
    log('watchdog: handed off to launchd instance');
    return true;
  } catch (err) {
    log('watchdog: error, running standalone', String(err));
    return false;
  }
}

// 使用者明確「結束」：卸載 agent（會一併結束由它啟動的 App），登入時仍會再啟動
function stop() {
  const r = launchctl('bootout', `${DOMAIN}/${LABEL}`);
  log('watchdog: bootout', r.code, r.out.trim());
  return r.code === 0;
}

function setRunAtLoad(runAtLoad) {
  try {
    writePlist(runAtLoad); // 下次登入生效
  } catch (err) {
    log('watchdog: write plist failed', String(err));
  }
}

module.exports = { ensure, stop, setRunAtLoad, isUnderLaunchd, LABEL, PLIST };

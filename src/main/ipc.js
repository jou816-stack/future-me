'use strict';
const { ipcMain, shell, app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { spawnSync } = require('child_process');
const { createVault, encrypt, decrypt, WrongPassphraseError } = require('./crypto');
const watchdog = require('./watchdog');

function toClientError(err) {
  if (err instanceof WrongPassphraseError) return { ok: false, code: 'WRONG_PASSPHRASE', message: '密碼不對' };
  if (err && err.code === 'LOCKED') return { ok: false, code: 'LOCKED', message: err.message };
  console.error(err);
  return { ok: false, code: 'ERROR', message: err.message || String(err) };
}

function register({ store, session, scheduler, windows }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      try {
        const data = await fn(payload || {}, event);
        return { ok: true, data };
      } catch (err) {
        return toClientError(err);
      }
    });

  handle('state:get', () => {
    const vault = store.getVault();
    return {
      hasVault: !!vault,
      hint: vault ? vault.hint : '',
      unlocked: session.isUnlocked(),
      config: store.getConfig(),
      dataDir: store.dir,
      isPackaged: app.isPackaged,
    };
  });

  handle('vault:setup', ({ passphrase, hint, openAtLogin }) => {
    if (store.hasVault()) throw new Error('主密碼已經設定過了');
    if (!passphrase || passphrase.length < 6) throw new Error('密碼至少 6 個字');
    if (!hint || !hint.trim()) throw new Error('請寫一句密碼提示');
    store.ensureDirs();
    const { vault, key } = createVault(passphrase, hint.trim());
    store.setVault(vault);
    session.key = key;
    session.touch();
    store.setConfig({ open_at_login: !!openAtLogin });
    if (app.isPackaged) watchdog.setRunAtLoad(!!openAtLogin);
    return true;
  });

  handle('session:unlock', ({ passphrase }) => session.unlock(passphrase));
  handle('session:lock', () => {
    session.lock();
    return true;
  });

  handle('vault:change', ({ oldPassphrase, newPassphrase, hint }) => {
    if (!newPassphrase || newPassphrase.length < 6) throw new Error('新密碼至少 6 個字');
    if (!hint || !hint.trim()) throw new Error('請寫一句新的密碼提示');
    session.unlock(oldPassphrase); // 錯就丟 WrongPassphraseError
    const oldKey = session.key;
    // 先把每一封都解開，確定全部沒問題，才開始寫入
    const plain = store.getIndex().map((l) => ({ id: l.id, body: decrypt(oldKey, store.readSealed(l.id)) }));
    const { vault, key } = createVault(newPassphrase, hint.trim());
    for (const p of plain) store.writeSealed(p.id, encrypt(key, p.body));
    store.setVault(vault);
    session.lock();
    session.key = key;
    session.touch();
    return true;
  });

  handle('letters:list', () => store.getIndex());

  handle('letters:seal', ({ title, epigraph, deliver_at, body, paper }) => {
    const key = session.requireKey();
    if (!body || !body.trim()) throw new Error('信的內容是空的');
    const when = new Date(deliver_at);
    if (Number.isNaN(when.getTime())) throw new Error('送達時間格式不對');
    if (when <= new Date()) throw new Error('送達時間必須在未來');
    const sealed = encrypt(key, body);
    const paperId = typeof paper === 'string' && /^[a-z]{1,20}$/.test(paper) ? paper : 'plain';
    const entry = store.addLetter({ title, epigraph, deliver_at: when.toISOString(), paper: paperId }, sealed);
    windows.broadcast('letters:changed');
    windows.refreshBadge();
    return entry;
  });

  handle('letters:open', ({ id }) => {
    const key = session.requireKey();
    const letter = store.getLetter(id);
    if (!letter) throw new Error('找不到這封信');
    if (letter.status === 'sealed') throw new Error('這封信還沒到送達時間');
    const body = decrypt(key, store.readSealed(id));
    windows.unpin(id);
    if (letter.status !== 'opened') {
      store.updateLetter(id, { status: 'opened', opened_at: new Date().toISOString() });
      windows.broadcast('letters:changed');
      windows.refreshBadge();
    }
    const reflectionSealed = store.readReflection(id);
    const reflection = reflectionSealed ? decrypt(key, reflectionSealed) : '';
    return { letter: store.getLetter(id), body, reflection };
  });

  // 讀完信之後寫下的反思：跟信一樣加密，存成 <id>.reflection.sealed
  handle('letters:reflect', ({ id, text }) => {
    const key = session.requireKey();
    const letter = store.getLetter(id);
    if (!letter) throw new Error('找不到這封信');
    if (letter.status !== 'opened') throw new Error('這封信還沒拆開');
    if (!text || !text.trim()) throw new Error('反思是空的');
    store.writeReflection(id, encrypt(key, text));
    const updated = store.updateLetter(id, { reflected_at: new Date().toISOString() });
    windows.broadcast('letters:changed');
    return updated;
  });

  handle('letters:cancel', ({ id }) => {
    session.requireKey();
    const letter = store.getLetter(id);
    if (!letter) throw new Error('找不到這封信');
    store.removeLetter(id);
    windows.broadcast('letters:changed');
    windows.refreshBadge();
    return true;
  });

  handle('config:set', (patch) => {
    const allowed = ['deliver_default_time', 'nag_time', 'autolock_minutes', 'open_at_login'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    const next = store.setConfig(clean);
    if ('open_at_login' in clean && app.isPackaged) watchdog.setRunAtLoad(!!clean.open_at_login);
    return next;
  });

  handle('misc:openFolder', () => {
    store.ensureDirs();
    shell.openPath(store.dir);
    return true;
  });

  // 備份：把整個資料夾（含加密信件、反思、vault）壓成 zip，檔案本身仍是加密的
  handle('misc:backup', async (_p, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '備份整個信箱',
      defaultPath: path.join(app.getPath('desktop'), `Future Me 備份 ${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return null;
    store.ensureDirs();
    const r = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', store.dir, filePath], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('備份失敗：' + (r.stderr || '').trim());
    return filePath;
  });

  handle('misc:checkNow', () => {
    scheduler.check();
    return true;
  });

  handle('window:close', (_p, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    return true;
  });

  handle('window:dirty', ({ dirty }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.isDirty = !!dirty;
    return true;
  });
}

module.exports = { register };

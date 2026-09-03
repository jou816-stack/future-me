'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // 狀態
  getState: () => invoke('state:get'),

  // 主密碼
  setupVault: (p) => invoke('vault:setup', p),
  unlock: (passphrase) => invoke('session:unlock', { passphrase }),
  lock: () => invoke('session:lock'),
  changePassphrase: (p) => invoke('vault:change', p),

  // 信件
  listLetters: () => invoke('letters:list'),
  sealLetter: (p) => invoke('letters:seal', p),
  openLetter: (id) => invoke('letters:open', { id }),
  cancelLetter: (id) => invoke('letters:cancel', { id }),
  reflectLetter: (id, text) => invoke('letters:reflect', { id, text }),

  // 設定與雜項
  setConfig: (patch) => invoke('config:set', patch),
  openDataFolder: () => invoke('misc:openFolder'),
  backup: () => invoke('misc:backup'),
  checkNow: () => invoke('misc:checkNow'),
  closeWindow: () => invoke('window:close'),
  setDirty: (dirty) => invoke('window:dirty', { dirty }),

  // 主程序推播
  onLettersChanged: (cb) => ipcRenderer.on('letters:changed', () => cb()),
  onLocked: (cb) => ipcRenderer.on('session:locked', () => cb()),
  onNavigate: (cb) => ipcRenderer.on('nav', (_e, view) => cb(view)),
});

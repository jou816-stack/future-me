'use strict';
// 解鎖狀態：金鑰只存在這裡（主程序記憶體），逾時自動清除。
const { unlock: vaultUnlock, wipe } = require('./crypto');

class Session {
  constructor(store) {
    this.store = store;
    this.key = null;
    this.timer = null;
    this.onLock = null;
  }

  isUnlocked() {
    return this.key !== null;
  }

  unlock(passphrase) {
    const vault = this.store.getVault();
    if (!vault) throw new Error('尚未設定主密碼');
    const key = vaultUnlock(vault, passphrase); // 錯密碼會丟 WrongPassphraseError
    this.lock();
    this.key = key;
    this.touch();
    return true;
  }

  // 每次使用金鑰就延長逾時
  touch() {
    if (this.timer) clearTimeout(this.timer);
    const minutes = Number(this.store.getConfig().autolock_minutes) || 15;
    this.timer = setTimeout(() => this.lock(), minutes * 60 * 1000);
  }

  requireKey() {
    if (!this.key) {
      const err = new Error('需要先輸入主密碼');
      err.code = 'LOCKED';
      throw err;
    }
    this.touch();
    return this.key;
  }

  lock() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.key) {
      wipe(this.key);
      this.key = null;
      if (this.onLock) this.onLock();
    }
  }
}

module.exports = { Session };

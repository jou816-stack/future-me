'use strict';
// 資料存取：~/Future Me/
//   config.json  設定
//   vault.json   主密碼驗證（salt + canary + 提示）
//   index.json   信封層（明文：日期、標題、引言、狀態）
//   letters/<id>.sealed  正文密文
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  deliver_default_time: '09:00',
  nag_time: '09:00',
  autolock_minutes: 15,
  open_at_login: true,
};

class Store {
  constructor(dataDir) {
    this.dir = dataDir || process.env.FUTURE_LETTER_DATA_DIR || path.join(os.homedir(), 'Future Me');
    this.lettersDir = path.join(this.dir, 'letters');
    this.paths = {
      config: path.join(this.dir, 'config.json'),
      vault: path.join(this.dir, 'vault.json'),
      index: path.join(this.dir, 'index.json'),
    };
  }

  ensureDirs() {
    fs.mkdirSync(this.lettersDir, { recursive: true, mode: 0o700 });
  }

  _readJson(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  _writeJson(p, obj) {
    this.ensureDirs();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p); // 原子寫入，避免寫到一半當機把 index 弄壞
  }

  // ---- config ----
  getConfig() {
    return { ...DEFAULT_CONFIG, ...this._readJson(this.paths.config, {}) };
  }
  setConfig(patch) {
    const next = { ...this.getConfig(), ...patch };
    this._writeJson(this.paths.config, next);
    return next;
  }

  // ---- vault ----
  hasVault() {
    return fs.existsSync(this.paths.vault);
  }
  getVault() {
    return this._readJson(this.paths.vault, null);
  }
  setVault(vault) {
    this._writeJson(this.paths.vault, vault);
  }

  // ---- index（信封層）----
  getIndex() {
    return this._readJson(this.paths.index, []);
  }
  setIndex(list) {
    this._writeJson(this.paths.index, list);
  }
  getLetter(id) {
    return this.getIndex().find((l) => l.id === id) || null;
  }
  updateLetter(id, patch) {
    const list = this.getIndex();
    const i = list.findIndex((l) => l.id === id);
    if (i < 0) throw new Error('找不到這封信');
    list[i] = { ...list[i], ...patch };
    this.setIndex(list);
    return list[i];
  }

  // ---- 信紙（密文）----
  newId() {
    return crypto.randomBytes(3).toString('hex');
  }
  sealedPath(id) {
    return path.join(this.lettersDir, `${id}.sealed`);
  }
  writeSealed(id, sealed) {
    this.ensureDirs();
    fs.writeFileSync(this.sealedPath(id), JSON.stringify(sealed), { mode: 0o600 });
  }
  readSealed(id) {
    return JSON.parse(fs.readFileSync(this.sealedPath(id), 'utf8'));
  }
  reflectionPath(id) {
    return path.join(this.lettersDir, `${id}.reflection.sealed`);
  }
  writeReflection(id, sealed) {
    this.ensureDirs();
    fs.writeFileSync(this.reflectionPath(id), JSON.stringify(sealed), { mode: 0o600 });
  }
  readReflection(id) {
    try {
      return JSON.parse(fs.readFileSync(this.reflectionPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  removeSealed(id) {
    try {
      fs.unlinkSync(this.reflectionPath(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      fs.unlinkSync(this.sealedPath(id));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  addLetter({ title, epigraph, deliver_at, paper }, sealed) {
    const id = this.newId();
    this.writeSealed(id, sealed);
    const entry = {
      id,
      title: title || '',
      epigraph: epigraph || '',
      paper: paper || 'plain',
      created_at: new Date().toISOString(),
      deliver_at,
      status: 'sealed',
      delivered_at: null,
      opened_at: null,
      reflected_at: null,
      last_nagged: null,
    };
    const list = this.getIndex();
    list.push(entry);
    this.setIndex(list);
    return entry;
  }

  removeLetter(id) {
    this.removeSealed(id);
    this.setIndex(this.getIndex().filter((l) => l.id !== id));
  }
}

module.exports = { Store, DEFAULT_CONFIG };

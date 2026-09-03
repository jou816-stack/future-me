'use strict';
// 加密核心：scrypt 派生金鑰 + AES-256-GCM
// 全部使用 Node 內建 crypto，不依賴任何外部指令或套件。
const crypto = require('crypto');

const CANARY_TEXT = 'future-letter-ok';
const KDF_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LEN = 32;
const IV_LEN = 12;

class WrongPassphraseError extends Error {
  constructor() {
    super('密碼不對');
    this.name = 'WrongPassphraseError';
  }
}

function deriveKey(passphrase, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LEN, KDF_PARAMS);
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
}

function decrypt(key, sealed) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
    return out.toString('utf8');
  } catch (err) {
    // GCM 驗證失敗 = 金鑰錯或檔案被動過
    throw new WrongPassphraseError();
  }
}

// 建立新的 vault（首次設定）
function createVault(passphrase, hint) {
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveKey(passphrase, salt);
  const canary = encrypt(key, CANARY_TEXT);
  return {
    vault: { version: 1, kdf: 'scrypt', salt, N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, canary, hint },
    key,
  };
}

// 用 vault 驗證密碼，成功回傳金鑰；失敗丟 WrongPassphraseError
function unlock(vault, passphrase) {
  const key = deriveKey(passphrase, vault.salt);
  const text = decrypt(key, vault.canary); // 錯密碼會在這裡丟錯
  if (text !== CANARY_TEXT) throw new WrongPassphraseError();
  return key;
}

function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

module.exports = { createVault, unlock, encrypt, decrypt, wipe, WrongPassphraseError, CANARY_TEXT };

'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createVault, unlock, encrypt, decrypt, WrongPassphraseError } = require('../src/main/crypto');
const { Store } = require('../src/main/store');

// 1. 加解密 round-trip
const { vault, key } = createVault('正確的密碼', '提示');
const body = '親愛的三年後的我，\n\n這段話有換行、有 emoji 🌱、有「引號」。';
const sealed = encrypt(key, body);
assert.strictEqual(decrypt(key, sealed), body);
assert.notStrictEqual(sealed.data, Buffer.from(body).toString('base64'));

// 2. 正確密碼能解鎖
const key2 = unlock(vault, '正確的密碼');
assert.strictEqual(decrypt(key2, sealed), body);

// 3. 錯密碼要丟 WrongPassphraseError，而不是回亂碼
assert.throws(() => unlock(vault, '錯的密碼'), WrongPassphraseError);
const wrongKey = require('crypto').randomBytes(32);
assert.throws(() => decrypt(wrongKey, sealed), WrongPassphraseError);

// 4. Store 在暫存資料夾的完整流程
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-letter-'));
const store = new Store(dir);
store.ensureDirs();
store.setVault(vault);
assert.ok(store.hasVault());
const entry = store.addLetter({ title: 'T', epigraph: 'E', deliver_at: '2027-03-01T09:00:00+08:00' }, sealed);
assert.strictEqual(store.getIndex().length, 1);
const raw = fs.readFileSync(store.sealedPath(entry.id), 'utf8');
assert.ok(!raw.includes('親愛的'), '密文檔不可含明文');
assert.strictEqual(decrypt(key, store.readSealed(entry.id)), body);
// 反思：加密存在信旁邊，刪信時一起刪
assert.strictEqual(store.readReflection(entry.id), null);
store.writeReflection(entry.id, encrypt(key, '讀完之後想說的話'));
assert.strictEqual(decrypt(key, store.readReflection(entry.id)), '讀完之後想說的話');
assert.ok(!fs.readFileSync(store.reflectionPath(entry.id), 'utf8').includes('讀完'));
store.updateLetter(entry.id, { status: 'opened' });
assert.strictEqual(store.getLetter(entry.id).status, 'opened');
store.removeLetter(entry.id);
assert.strictEqual(store.getIndex().length, 0);
assert.ok(!fs.existsSync(store.sealedPath(entry.id)));
assert.ok(!fs.existsSync(store.reflectionPath(entry.id)));
fs.rmSync(dir, { recursive: true });

console.log('crypto + store: all tests passed');

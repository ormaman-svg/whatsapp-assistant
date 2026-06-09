'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_PREFIX = 'rio-user-key-v1';

let masterKey;

let _warnedNoKey = false;

function getMasterKey() {
  if (masterKey) return masterKey;
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) {
    if (!_warnedNoKey) {
      console.error('[SECURITY] ENCRYPTION_MASTER_KEY is not set — all encryption is DISABLED. User data is stored in plaintext.');
      _warnedNoKey = true;
    }
    return null;
  }
  masterKey = Buffer.from(raw, 'base64');
  if (masterKey.length < 32) {
    masterKey = crypto.createHash('sha256').update(raw).digest();
  }
  return masterKey;
}

function deriveUserKey(userId) {
  const mk = getMasterKey();
  if (!mk) return null;
  return crypto.pbkdf2Sync(mk, `${SALT_PREFIX}:${userId}`, 100_000, 32, 'sha256');
}

function encrypt(plaintext, userId) {
  const key = deriveUserKey(userId);
  if (!key) {
    if (process.env.NODE_ENV === 'production') throw new Error('Encryption unavailable: ENCRYPTION_MASTER_KEY not set');
    return plaintext;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

function decrypt(ciphertext, userId) {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith('enc:')) return ciphertext;
  const key = deriveUserKey(userId);
  if (!key) return ciphertext;
  try {
    const buf = Buffer.from(ciphertext.slice(4), 'base64');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return ciphertext;
  }
}

function encryptArray(arr, userId) {
  if (!getMasterKey() || !Array.isArray(arr)) return arr;
  return arr.map((item) => (typeof item === 'string' ? encrypt(item, userId) : item));
}

function decryptArray(arr, userId) {
  if (!getMasterKey() || !Array.isArray(arr)) return arr;
  return arr.map((item) => (typeof item === 'string' ? decrypt(item, userId) : item));
}

function encryptObject(obj, userId, fields) {
  if (!getMasterKey() || !obj) return obj;
  const result = { ...obj };
  for (const f of fields) {
    if (typeof result[f] === 'string') result[f] = encrypt(result[f], userId);
  }
  return result;
}

function decryptObject(obj, userId, fields) {
  if (!getMasterKey() || !obj) return obj;
  const result = { ...obj };
  for (const f of fields) {
    if (typeof result[f] === 'string') result[f] = decrypt(result[f], userId);
  }
  return result;
}

function encryptJSON(obj, userId) {
  if (!getMasterKey() || !obj) return obj;
  const json = JSON.stringify(obj);
  return encrypt(json, userId);
}

function decryptJSON(ciphertext, userId) {
  if (!getMasterKey() || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith('enc:')) return ciphertext;
  try {
    const json = decrypt(ciphertext, userId);
    return JSON.parse(json);
  } catch {
    return ciphertext;
  }
}

function hmacSign(data, purpose) {
  const mk = getMasterKey();
  if (!mk) return null;
  return crypto.createHmac('sha256', mk).update(`${purpose}:${data}`).digest('hex');
}

function hmacVerify(data, purpose, signature) {
  const expected = hmacSign(data, purpose);
  if (!expected || !signature) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isEnabled() {
  return !!getMasterKey();
}

module.exports = { encrypt, decrypt, encryptArray, decryptArray, encryptObject, decryptObject, encryptJSON, decryptJSON, hmacSign, hmacVerify, isEnabled };

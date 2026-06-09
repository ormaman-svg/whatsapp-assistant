'use strict';

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { encrypt, decrypt } = require('./crypto');

const COLLECTION = 'baileys-auth';
const BAILEYS_USER_ID = '__baileys_auth__';

function getDb() {
  const { Firestore } = require('@google-cloud/firestore');
  let db;
  return (() => {
    if (!db) {
      db = new Firestore({
        projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
        databaseId: process.env.FIRESTORE_DATABASE_ID || 'whatsapp-assistant',
      });
    }
    return db;
  })();
}

function fixKey(key) {
  return key.replace(/\//g, '__').replace(/:/g, '-');
}

async function useFirestoreAuthState() {
  const db = getDb();
  const col = db.collection(COLLECTION);
  console.log('[baileys-auth] Loading session from Firestore...');

  async function readData(key) {
    const snap = await col.doc(fixKey(key)).get();
    if (!snap.exists) return null;
    let raw = snap.data()?.value;
    if (!raw) return null;
    raw = decrypt(raw, BAILEYS_USER_ID);
    return JSON.parse(raw, BufferJSON.reviver);
  }

  async function writeData(key, data) {
    const plaintext = JSON.stringify(data, BufferJSON.replacer);
    const value = encrypt(plaintext, BAILEYS_USER_ID);
    await col.doc(fixKey(key)).set({ value, updatedAt: new Date() });
  }

  async function removeData(key) {
    try {
      await col.doc(fixKey(key)).delete();
    } catch { /* ignore */ }
  }

  const creds = (await readData('creds')) || initAuthCreds();
  console.log('[baileys-auth] Creds document loaded');

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          })
        );
        return data;
      },
      set: async (data) => {
        const tasks = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const key = `${category}-${id}`;
            tasks.push(value ? writeData(key, value) : removeData(key));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: () => writeData('creds', state.creds),
  };
}

async function getPNForLID(lidJid) {
  if (!lidJid) return null;
  const lidUser = String(lidJid).split('@')[0].split(':')[0];
  if (!lidUser) return null;

  const db = getDb();
  const col = db.collection(COLLECTION);
  try {
    const doc = await col.doc(fixKey(`lid-mapping-${lidUser}_reverse`)).get();
    if (!doc.exists) return null;
    let raw = doc.data()?.value;
    if (!raw) return null;
    try { raw = decrypt(raw, BAILEYS_USER_ID); } catch (e) { /* not encrypted */ }
    const pnUser = JSON.parse(raw, BufferJSON.reviver);
    return typeof pnUser === 'string' ? pnUser : null;
  } catch (err) {
    console.error('[baileys-auth] getPNForLID failed:', err.message);
    return null;
  }
}

module.exports = { useFirestoreAuthState, getPNForLID };

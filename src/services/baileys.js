'use strict';

const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const NodeCache = require('@cacheable/node-cache').default;
const { useFirestoreAuthState } = require('./baileys-auth');
const P = require('pino');

const logger = P({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
const msgRetryCounterCache = new NodeCache({ stdTTL: 1800, useClones: false });

let sock = null;
let connectionState = 'disconnected';
let messageHandler = null;
let reconnectAttempts = 0;
let lastQR = null;
const MAX_RECONNECT_DELAY = 60_000;

async function clearFirestoreAuth() {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const db = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      databaseId: process.env.FIRESTORE_DATABASE_ID || 'whatsapp-assistant',
    });
    const docs = await db.collection('baileys-auth').listDocuments();
    for (const doc of docs) await doc.delete();
    console.log(`[baileys] Cleared ${docs.length} auth docs from Firestore`);
  } catch (err) {
    console.error('[baileys] Failed to clear auth:', err.message);
  }
}

async function initBaileys(onMessage) {
  if (onMessage) messageHandler = onMessage;

  // Without this, each reconnect stacks a new socket while the old one may still
  // decrypt traffic — causes Noise errors and endless connectionClosed (428) loops.
  if (sock) {
    console.log('[baileys] Ending previous socket before new connection');
    try {
      sock.end(undefined);
    } catch (e) {
      console.warn('[baileys] Previous socket end failed:', e.message);
    }
    sock = null;
  }

  console.log('[baileys] Initializing connection...');
  const { state, saveCreds } = await useFirestoreAuthState();

  const versionTimeoutMs = Number(process.env.BAILEYS_VERSION_FETCH_MS) || 45_000;
  let version;
  try {
    console.log('[baileys] Fetching latest WhatsApp web version...');
    const fetchVer = fetchLatestBaileysVersion();
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`fetchLatestBaileysVersion timed out after ${versionTimeoutMs}ms`)), versionTimeoutMs);
    });
    ({ version } = await Promise.race([fetchVer, timeout]));
    console.log(`[baileys] Using WA version ${version.join('.')}`);
  } catch (err) {
    console.error('[baileys] Version fetch failed, using bundled fallback:', err.message);
    version = [2, 3000, 1027934701];
    console.log(`[baileys] Fallback WA version ${version.join('.')}`);
  }

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    msgRetryCounterCache,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      console.log('[baileys] New QR code generated — scan at /admin/pair');
    }

    if (connection === 'open') {
      connectionState = 'open';
      reconnectAttempts = 0;
      lastQR = null;
      console.log('[baileys] Connected to WhatsApp');
      setupProfile().catch(err => console.error('[baileys] Profile setup error:', err.message));
    }

    if (connection === 'connecting') {
      connectionState = 'connecting';
      console.log('[baileys] Connecting...');
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[baileys] Disconnected: ${reason} (${statusCode})`);

      if (reconnectAttempts >= 7 && statusCode === DisconnectReason.connectionClosed) {
        console.warn(
          '[baileys] Many connectionClosed disconnects — session may be invalid. ' +
            'On the phone: WhatsApp → Settings → Linked devices — remove Rio if stuck, then scan QR at /admin/pair'
        );
      }

      if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
        console.log('[baileys] connectionReplaced — new instance took over. Exiting.');
        process.exit(0); return;
      }
      if (loggedOut) {
        console.log('[baileys] Logged out — clearing auth and retrying...');
        await clearFirestoreAuth();
        reconnectAttempts = 0;
      }

      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
      console.log(`[baileys] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
      setTimeout(() => initBaileys(), delay);
    }
  });

  if (messageHandler) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') {
        console.log(`[baileys] messages.upsert type=${type} count=${messages.length}`);
        return;
      }
      for (const m of messages) {
        try {
          await messageHandler(m);
        } catch (err) {
          console.error('[baileys] Message handler error:', err.message);
        }
      }
    });
  }

  setupGracefulShutdown();
  return sock;
}

let shutdownRegistered = false;

function setupGracefulShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal) => {
    console.log(`[baileys] ${signal} received — closing connection...`);
    if (sock) {
      try {
        sock.end(undefined);
      } catch { /* ignore */ }
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function getSocket() {
  return sock;
}

function getConnectionState() {
  return connectionState;
}

function getLastQR() {
  return lastQR;
}

let profileSetupDone = false;

async function setupProfile() {
  if (profileSetupDone || !sock) return;

  await new Promise(r => setTimeout(r, 5000));
  if (connectionState !== 'open' || !sock) return;

  const landingUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';

  try {
    await sock.updateProfileName('Rio');
    console.log('[baileys] Profile name set');
  } catch (err) {
    console.error('[baileys] Profile name failed:', err.message);
  }

  try {
    await sock.updateProfileStatus('העוזר האישי החכם שלך בוואטסאפ ⚡');
    console.log('[baileys] Profile about updated');
  } catch (err) {
    console.error('[baileys] Profile about failed:', err.message);
  }

  try {
    await sock.updateCallPrivacy('known');
    console.log('[baileys] Incoming calls blocked');
  } catch (err) {
    console.error('[baileys] Call privacy failed:', err.message);
  }

  try {
    const RTL = '\u200F';
    await sock.updateBussinesProfile({
      description: [
        `${RTL}Rio הוא סוכן AI אישי שחי בוואטסאפ שלך.`,
        `${RTL}שלח הודעה ו-Rio יעזור לך עם כל מה שצריך:`,
        '',
        `${RTL}✓ ניהול יומן, מיילים ו-Google Drive`,
        `${RTL}✓ חיפוש מידע בזמן אמת`,
        `${RTL}✓ יצירת תמונות ומוזיקה`,
        `${RTL}✓ מעקב הוצאות ותזכורות`,
        `${RTL}✓ רשימות, משימות והערות`,
        `${RTL}✓ ניווט ומיקום`,
        `${RTL}✓ שליחת הודעות בשמך`,
        `${RTL}✓ ניתוח מסמכים ותמונות`,
        '',
        `${RTL}פשוט תכתבו — Rio ידע לעזור.`,
      ].join('\n'),
      websites: [landingUrl],
      address: 'Israel',
      email: '',
    });
    console.log('[baileys] Business profile updated');
  } catch (err) {
    console.error('[baileys] Business profile failed:', err.message);
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const sharp = require('sharp');

    const iconPath = path.join(__dirname, '..', 'public', 'rio-icon.png');
    if (fs.existsSync(iconPath)) {
      const squareImg = await sharp(iconPath)
        .flatten({ background: { r: 37, g: 211, b: 102 } })
        .resize(640, 640, { fit: 'cover' })
        .png()
        .toBuffer();
      await sock.updateProfilePicture(sock.user.id, squareImg);
      console.log('[baileys] Profile picture updated');
    }
  } catch (err) {
    console.error('[baileys] Profile picture failed:', err.message);
  }

  profileSetupDone = true;
}

async function updateProfilePicture(imgBuffer) {
  if (!sock) throw new Error('WhatsApp not connected');
  await sock.updateProfilePicture(sock.user.id, imgBuffer);
  console.log('[baileys] Profile picture updated manually');
}

async function updateProfileName(name) {
  if (!sock) throw new Error('WhatsApp not connected');
  await sock.updateProfileName(name);
  console.log(`[baileys] Profile name updated to "${name}"`);
}

async function updateProfileAbout(text) {
  if (!sock) throw new Error('WhatsApp not connected');
  await sock.updateProfileStatus(text);
  console.log(`[baileys] Profile about updated`);
}

module.exports = { initBaileys, getSocket, getConnectionState, getLastQR, updateProfilePicture, updateProfileName, updateProfileAbout };

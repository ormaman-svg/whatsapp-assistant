'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { encryptJSON, decryptJSON, hmacSign, hmacVerify } = require('./crypto');

const TOKENS_DIR = path.join(__dirname, '..', '..', 'tokens');
const LEGACY_TOKENS_PATH = path.join(__dirname, '..', '..', '.tokens.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const userClients = new Map();

let _db;
function lazyDb() {
  if (_db === undefined) {
    try { _db = require('./database'); } catch { _db = null; }
  }
  return _db;
}

function ensureTokensDir() {
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Get the OAuth2 client for a specific user (by phone number).
 * Requires a userId -- never falls back to a shared default.
 * Prefer getOAuth2ClientAsync when possible for Firestore-backed token loading.
 */
function getOAuth2Client(userId) {
  if (!userId) {
    throw new Error('[google-auth] getOAuth2Client called without userId — refusing to use shared default');
  }

  if (userClients.has(userId)) return userClients.get(userId);

  const client = createOAuth2Client();
  const tokens = loadTokens(userId);

  if (tokens) {
    client.setCredentials(tokens);
    setupTokenRefreshHandler(client, userId);
  }

  userClients.set(userId, client);
  return client;
}

async function getOAuth2ClientAsync(userId) {
  if (!userId) {
    throw new Error('[google-auth] getOAuth2ClientAsync called without userId');
  }

  if (userClients.has(userId)) return userClients.get(userId);

  const client = createOAuth2Client();
  const tokens = await loadTokensAsync(userId);

  if (tokens) {
    client.setCredentials(tokens);
    setupTokenRefreshHandler(client, userId);
    console.log(`[google-auth] Loaded tokens (async)`);
  }

  userClients.set(userId, client);
  return client;
}

function setupTokenRefreshHandler(client, userId) {
  client.on('tokens', (newTokens) => {
    const existing = loadTokens(userId) || {};
    const merged = { ...existing, ...newTokens };
    saveTokens(userId, merged);
    client.setCredentials(merged);
    console.log('[google-auth] Tokens refreshed');
  });
}

/**
 * Generate an auth URL for a specific user.
 * The userId is encoded in the state parameter so the callback knows who to associate tokens with.
 */
function getAuthUrl(userId) {
  if (!userId) throw new Error('[google-auth] getAuthUrl requires userId');
  const client = createOAuth2Client();
  const sig = hmacSign(userId, 'oauth-state');
  if (!sig) throw new Error('[google-auth] Cannot generate OAuth URL: ENCRYPTION_MASTER_KEY is not set');
  const state = `${userId}:${sig}`;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

function parseOAuthState(state) {
  if (!state) return null;
  const colonIdx = state.lastIndexOf(':');
  if (colonIdx === -1) {
    console.error('[google-auth] Rejecting unsigned OAuth state');
    return null;
  }
  const userId = state.substring(0, colonIdx);
  const sig = state.substring(colonIdx + 1);
  if (hmacVerify(userId, 'oauth-state', sig)) return userId;
  console.error('[google-auth] Invalid OAuth state signature');
  return null;
}

async function handleCallback(code, userId) {
  const client = getOAuth2Client(userId);
  const { tokens } = await client.getToken(code);
  saveTokens(userId, tokens);
  client.setCredentials(tokens);
  setupTokenRefreshHandler(client, userId);

  userClients.set(userId, client);
  console.log('[google-auth] OAuth completed');
  return tokens;
}

async function isAuthenticated(userId) {
  try {
    const client = await getOAuth2ClientAsync(userId);
    return !!client.credentials?.access_token || !!client.credentials?.refresh_token;
  } catch {
    return false;
  }
}

const _tokenCache = new Map();

function loadTokens(userId) {
  if (!userId) return null;

  if (_tokenCache.has(userId)) return _tokenCache.get(userId);

  const envKey = `GOOGLE_TOKENS_${userId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (process.env[envKey]) {
    try {
      const tokens = JSON.parse(Buffer.from(process.env[envKey], 'base64').toString('utf8'));
      _tokenCache.set(userId, tokens);
      return tokens;
    } catch (err) {
      console.error(`[google-auth] Failed to decode ${envKey}:`, err.message);
    }
  }

  ensureTokensDir();
  const userPath = path.join(TOKENS_DIR, `${userId}.json`);
  try {
    if (fs.existsSync(userPath)) {
      const raw = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      let tokens;
      if (raw.encrypted && typeof raw.data === 'string') {
        tokens = decryptJSON(raw.data, userId);
      } else if (raw.access_token || raw.refresh_token) {
        tokens = raw;
      }
      if (tokens && (tokens.access_token || tokens.refresh_token)) {
        _tokenCache.set(userId, tokens);
        return tokens;
      }
    }
  } catch (err) {
    const masked = userId.length > 5 ? userId.slice(0, 3) + '***' + userId.slice(-2) : '***';
    console.error(`[google-auth] Failed to load tokens for ${masked}:`, err.message);
  }

  return null;
}

async function loadTokensAsync(userId) {
  if (!userId) return null;

  const sync = loadTokens(userId);
  if (sync) return sync;

  const db = lazyDb();
  if (!db) return null;
  try {
    const snap = await db.getDb()
      .collection('users').doc(userId)
      .collection('meta').doc('google_tokens').get();
    if (snap.exists) {
      const raw = snap.data();
      let tokens;
      if (raw.encrypted && typeof raw.data === 'string') {
        tokens = decryptJSON(raw.data, userId);
      } else {
        tokens = { ...raw };
        delete tokens.encrypted;
      }
      if (tokens && (tokens.access_token || tokens.refresh_token)) {
        _tokenCache.set(userId, tokens);
        return tokens;
      }
    }
  } catch (err) {
    console.error('[google-auth] Firestore load failed:', err.message);
  }
  return null;
}

function saveTokens(userId, tokens) {
  if (!userId || !tokens) return;

  _tokenCache.set(userId, tokens);

  ensureTokensDir();
  try {
    const diskData = encryptJSON(tokens, userId);
    fs.writeFileSync(path.join(TOKENS_DIR, `${userId}.json`), JSON.stringify({ encrypted: true, data: diskData }));
  } catch { /* container fs may be read-only */ }

  const db = lazyDb();
  if (db) {
    const encrypted = encryptJSON(tokens, userId);
    const payload = typeof encrypted === 'string'
      ? { encrypted: true, data: encrypted }
      : { encrypted: false, ...tokens };
    db.getDb()
      .collection('users').doc(userId)
      .collection('meta').doc('google_tokens')
      .set(payload)
      .then(() => console.log('[google-auth] Tokens persisted to Firestore'))
      .catch((err) => console.error('[google-auth] Firestore save failed:', err.message));
  }
}

/**
 * Migrate legacy single-user tokens to a specific user.
 */
function migrateLegacyTokens(primaryUserId) {
  if (!primaryUserId) return;

  if (loadTokens(primaryUserId)) return;

  const legacySources = [
    () => process.env.GOOGLE_TOKENS
      ? JSON.parse(Buffer.from(process.env.GOOGLE_TOKENS, 'base64').toString('utf8'))
      : null,
    () => fs.existsSync(LEGACY_TOKENS_PATH)
      ? JSON.parse(fs.readFileSync(LEGACY_TOKENS_PATH, 'utf8'))
      : null,
  ];

  for (const source of legacySources) {
    try {
      const tokens = source();
      if (tokens) {
        saveTokens(primaryUserId, tokens);
        console.log('[google-auth] Migrated legacy tokens');
        return;
      }
    } catch { /* skip */ }
  }
}

module.exports = { getOAuth2Client, getOAuth2ClientAsync, getAuthUrl, parseOAuthState, handleCallback, isAuthenticated, migrateLegacyTokens, SCOPES };

'use strict';

const MAX_HISTORY = 20;
const MAX_GROUP_HISTORY = 30;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 15 * 1000; // reduced from 30s → less history lost on restart

const sessions = new Map();
const dirty = new Set();

let db;
function lazyDb() {
  if (db === undefined) {
    try {
      db = require('./database');
    } catch {
      db = null;
    }
  }
  return db;
}

function getSession(key) {
  const now = Date.now();
  let session = sessions.get(key);

  if (!session || now - session.lastAccess > SESSION_TTL_MS) {
    session = { history: [], lastAccess: now, loaded: false };
    sessions.set(key, session);
  }

  session.lastAccess = now;
  return session;
}

async function ensureLoaded(key) {
  const session = getSession(key);
  if (session.loaded || !lazyDb()) return session;
  try {
    const stored = await lazyDb().loadSession(key);
    if (stored.length && !session.history.length) {
      session.history = stored;
    }
    session.loaded = true;
  } catch (err) {
    console.error(`[session] Failed to load from Firestore:`, err.message);
    session.loaded = true;
  }
  return session;
}

function addToHistory(key, role, parts) {
  const session = getSession(key);
  session.history.push({ role, parts });

  const max = key.startsWith('group:') ? MAX_GROUP_HISTORY : MAX_HISTORY;
  if (session.history.length > max) {
    session.history = session.history.slice(-max);
  }

  dirty.add(key);
}

function getHistory(key) {
  return getSession(key).history;
}

async function getHistoryAsync(key) {
  const session = await ensureLoaded(key);
  return session.history;
}

function clearSession(key) {
  sessions.delete(key);
  dirty.delete(key);
  if (lazyDb()) {
    lazyDb().deleteSession(key).catch((err) => console.error('[session] delete failed:', err.message));
  }
}

function groupKey(groupId) {
  return `group:${groupId}`;
}

function addGroupMessage(groupId, senderName, role, text) {
  const key = groupKey(groupId);
  const prefix = role === 'user' && senderName ? `[${senderName}] ` : '';
  addToHistory(key, role, [{ text: `${prefix}${text}` }]);
}

function getGroupHistory(groupId) {
  return getHistory(groupKey(groupId));
}

async function persistDirty() {
  if (!dirty.size || !lazyDb()) return;
  const keys = [...dirty];
  dirty.clear();
  for (const key of keys) {
    const session = sessions.get(key);
    if (!session) continue;
    try {
      await lazyDb().saveSession(key, session.history);
    } catch (err) {
      console.error(`[session] Persist failed for ${key}:`, err.message);
      dirty.add(key);
    }
  }
}

// Flush on exit so last messages aren't lost on Cloud Run restart/SIGTERM
function flushOnExit() { persistDirty().catch(() => {}); }
process.once('SIGTERM', flushOnExit);
process.once('SIGINT', flushOnExit);

setInterval(persistDirty, PERSIST_INTERVAL_MS);

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
      dirty.delete(id);
    }
  }
}

setInterval(pruneExpired, 30 * 60 * 1000);

module.exports = {
  addToHistory,
  getHistory,
  getHistoryAsync,
  clearSession,
  groupKey,
  addGroupMessage,
  getGroupHistory,
};

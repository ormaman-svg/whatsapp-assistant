'use strict';

const { getDb, Firestore } = require('./database');

const ADMIN_NUMBERS = new Set(['972527305577', '972525111226', '97252511126']);

const PLANS = {
  basic: {
    name: 'Basic',
    price: 99,
    currency: 'ILS',
    features: ['ai_chat', 'web_search', 'generate_image', 'edit_image', 'generate_music', 'search_places', 'get_directions', 'add_to_list', 'get_list', 'remove_from_list', 'list_all_lists', 'create_reminder', 'list_reminders', 'delete_reminder'],
  },
  pro: {
    name: 'Pro',
    price: 179,
    currency: 'ILS',
    features: 'all',
  },
  admin: {
    name: 'Admin',
    price: 0,
    currency: 'ILS',
    features: 'all',
  },
};

const PRO_ONLY_TOOLS = new Set([
  'search_emails', 'read_email', 'send_email', 'get_unread_count',
  'list_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'search_drive', 'read_drive_file', 'create_document',
  'remember', 'recall', 'forget',
  'add_expense', 'list_expenses', 'expense_summary',
  'send_whatsapp_message', 'lookup_contact',
  'summarize_emails', 'download_video', 'create_invoice', 'daily_briefing',
  'post_to_instagram', 'smart_home',
  'slack_unread', 'slack_read_channel', 'slack_send',
]);

// In-memory cache to avoid Firestore lookups on every message
const userCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function isAdmin(phone) {
  const normalized = String(phone).replace(/^\+/, '').trim();
  return ADMIN_NUMBERS.has(normalized);
}

async function getUser(phone) {
  const normalized = String(phone).replace(/^\+/, '').trim();

  if (isAdmin(normalized)) {
    return { phone: normalized, status: 'active', plan: 'admin', isAdmin: true };
  }

  const cached = userCache.get(normalized);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const snap = await getDb().collection('users').doc(normalized).get();
    const data = snap.exists ? { phone: normalized, ...snap.data() } : null;
    userCache.set(normalized, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[users] Failed to fetch user:', err.message);
    return null;
  }
}

async function createUser(phone, data = {}) {
  const normalized = String(phone).replace(/^\+/, '').trim();
  const user = {
    phone: normalized,
    status: 'pending',
    plan: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    name: data.name || null,
    email: data.email || null,
    googleConnected: false,
    onboardingStep: 'welcome',
    createdAt: Firestore.FieldValue.serverTimestamp(),
    ...data,
  };
  await getDb().collection('users').doc(normalized).set(user, { merge: true });
  userCache.delete(normalized);
  console.log('[users] Created user');
  return user;
}

async function activateUser(phone, { plan, stripeCustomerId, stripeSubscriptionId, email }) {
  const normalized = String(phone).replace(/^\+/, '').trim();
  const update = {
    status: 'active',
    plan,
    stripeCustomerId: stripeCustomerId || null,
    stripeSubscriptionId: stripeSubscriptionId || null,
    email: email || null,
    onboardingStep: 'google_oauth',
    activatedAt: Firestore.FieldValue.serverTimestamp(),
  };
  await getDb().collection('users').doc(normalized).set(update, { merge: true });
  userCache.delete(normalized);
  console.log(`[users] Activated user on plan=${plan}`);
}

async function deactivateUser(phone, reason = 'cancelled') {
  const normalized = String(phone).replace(/^\+/, '').trim();
  await getDb().collection('users').doc(normalized).set({
    status: reason,
    onboardingStep: 'expired',
  }, { merge: true });
  userCache.delete(normalized);
  console.log(`[users] Deactivated user: ${reason}`);
}

async function updateUser(phone, data) {
  const normalized = String(phone).replace(/^\+/, '').trim();
  await getDb().collection('users').doc(normalized).set(data, { merge: true });
  userCache.delete(normalized);
}

async function updateOnboardingStep(phone, step) {
  await updateUser(phone, { onboardingStep: step });
}

function getUserPlan(user) {
  if (!user) return null;
  if (user.isAdmin) return PLANS.admin;
  return PLANS[user.plan] || null;
}

function isToolAllowedForPlan(toolName, plan) {
  if (!plan) return false;
  if (plan.features === 'all') return true;
  return plan.features.includes(toolName);
}

function isProOnly(toolName) {
  return PRO_ONLY_TOOLS.has(toolName);
}

function clearCache(phone) {
  const normalized = String(phone).replace(/^\+/, '').trim();
  userCache.delete(normalized);
}

module.exports = {
  getUser,
  createUser,
  activateUser,
  deactivateUser,
  updateUser,
  updateOnboardingStep,
  getUserPlan,
  isToolAllowedForPlan,
  isProOnly,
  isAdmin,
  clearCache,
  PLANS,
  PRO_ONLY_TOOLS,
  ADMIN_NUMBERS,
};

'use strict';

const { getUser, isAdmin } = require('../services/users');

function normalizeNumber(phone) {
  return String(phone).replace(/^\+/, '').trim();
}

/**
 * Synchronous admin check -- fast path for Or and Sapir.
 * Used where async is not possible (e.g. isOwner flag in group routing).
 */
function isAllowed(phone) {
  return isAdmin(normalizeNumber(phone));
}

/**
 * Async check: is this phone number an active, paying user (or admin)?
 * Returns the user object if active, null otherwise.
 */
async function getActiveUser(phone) {
  const normalized = normalizeNumber(phone);
  const user = await getUser(normalized);
  if (!user) return null;
  if (user.isAdmin) return user;
  if (user.status === 'active') return user;
  return null;
}

/**
 * Async check: does this phone number exist in Firestore at all?
 * Returns the user object regardless of status (for onboarding flow).
 */
async function getAnyUser(phone) {
  const normalized = normalizeNumber(phone);
  return getUser(normalized);
}

module.exports = { isAllowed, getActiveUser, getAnyUser, normalizeNumber };

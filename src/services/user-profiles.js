'use strict';

/**
 * User profiles — maps phone numbers to names and preferences.
 * Loaded from USER_PROFILES env var as JSON, or uses hardcoded defaults.
 */

const DEFAULT_PROFILES = {
  '972527305577': { name: 'אור', nameEn: 'Or' },
  '972525111226': { name: 'ספיר', nameEn: 'Sapir' },
  '97252511126': { name: 'ספיר', nameEn: 'Sapir' },
};

let profiles = null;

function loadProfiles() {
  if (profiles) return profiles;

  if (process.env.USER_PROFILES) {
    try {
      profiles = JSON.parse(process.env.USER_PROFILES);
      return profiles;
    } catch (err) {
      console.error('[profiles] Failed to parse USER_PROFILES env:', err.message);
    }
  }

  profiles = DEFAULT_PROFILES;
  return profiles;
}

function getUserProfile(phoneNumber) {
  const p = loadProfiles();
  const normalized = phoneNumber.replace(/^\+/, '');
  return p[normalized] || null;
}

function getUserName(phoneNumber) {
  return getUserProfile(phoneNumber)?.name || null;
}

module.exports = { getUserProfile, getUserName };

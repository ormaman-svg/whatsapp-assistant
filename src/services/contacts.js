'use strict';

const { google } = require('googleapis');
const { getOAuth2ClientAsync } = require('./google-auth');
const { getUserProfile } = require('./user-profiles');
const { normalizePhoneNumber, formatPhoneForDisplay } = require('../utils/whatsapp');
const { getDb, Firestore } = require('./database');
const { encryptJSON, decryptJSON } = require('./crypto');

const learnedCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadLearnedForUser(ownerPhone) {
  const normalized = ownerPhone.replace(/^\+/, '');
  const cached = learnedCache.get(normalized);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  try {
    const snap = await getDb()
      .collection('users').doc(normalized)
      .collection('meta').doc('learned_contacts').get();
    let data = {};
    if (snap.exists) {
      const raw = snap.data();
      if (raw.encrypted && typeof raw.data === 'string') {
        data = decryptJSON(raw.data, normalized) || {};
      } else {
        data = raw.contacts || {};
      }
    }
    learnedCache.set(normalized, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[contacts] Failed to load learned contacts:', err.message);
    return {};
  }
}

async function saveLearnedForUser(ownerPhone, contacts) {
  const normalized = ownerPhone.replace(/^\+/, '');
  try {
    const encrypted = encryptJSON(contacts, normalized);
    const payload = typeof encrypted === 'string'
      ? { encrypted: true, data: encrypted, updatedAt: Firestore.FieldValue.serverTimestamp() }
      : { contacts, updatedAt: Firestore.FieldValue.serverTimestamp() };
    await getDb()
      .collection('users').doc(normalized)
      .collection('meta').doc('learned_contacts')
      .set(payload);
    learnedCache.set(normalized, { data: contacts, ts: Date.now() });
  } catch (err) {
    console.error('[contacts] Failed to save learned contacts:', err.message);
  }
}

/**
 * Auto-learn a contact from a WhatsApp interaction.
 * Stores under the owner's Firestore document so contacts are per-user.
 * `ownerPhone` = the user who "owns" the contact knowledge (for DMs, same as sender).
 */
async function learnContact(contactPhone, displayName, ownerPhone) {
  if (!contactPhone || !displayName || !ownerPhone) return;
  const normalizedContact = contactPhone.replace(/^\+/, '');
  const contacts = await loadLearnedForUser(ownerPhone);

  if (contacts[normalizedContact]?.name === displayName) return;

  contacts[normalizedContact] = {
    name: displayName,
    source: 'whatsapp',
    learnedAt: new Date().toISOString(),
  };
  await saveLearnedForUser(ownerPhone, contacts);
  console.log('[contacts] Learned new contact');
}

/**
 * Search Google Contacts by name.
 */
async function searchGoogleContacts(query, userId) {
  try {
    const auth = await getOAuth2ClientAsync(userId);
    const people = google.people({ version: 'v1', auth });
    const res = await people.people.searchContacts({
      query,
      readMask: 'names,phoneNumbers',
      pageSize: 10,
    });

    const results = [];
    for (const result of res.data.results || []) {
      const person = result.person;
      if (!person) continue;

      const name = person.names?.[0]?.displayName || '';
      const phones = (person.phoneNumbers || []).map((p) => {
        const num = normalizePhoneNumber(p.value || '');
        return { number: num, display: formatPhoneForDisplay(num), type: p.type || 'unknown' };
      });

      if (name && phones.length) {
        results.push({ name, phones, source: 'google' });
      }
    }
    return results;
  } catch (err) {
    console.error('[contacts] Google Contacts search failed:', err.message);
    return [];
  }
}

/**
 * Search learned contacts by name (fuzzy), scoped to the requesting user.
 */
async function searchLearnedContacts(query, userId) {
  const contacts = await loadLearnedForUser(userId);
  const lower = query.toLowerCase();
  const results = [];

  for (const [number, info] of Object.entries(contacts)) {
    if (info.name?.toLowerCase().includes(lower)) {
      results.push({
        name: info.name,
        phones: [{ number, display: formatPhoneForDisplay(number), type: 'whatsapp' }],
        source: 'whatsapp',
      });
    }
  }
  return results;
}

/**
 * Search known profiles (Or, Sapir, etc.) by name.
 */
function searchKnownProfiles(_query) {
  return [];
}

/**
 * Search contacts across all sources.
 * Priority: known profiles > Google Contacts > learned WhatsApp contacts.
 */
async function searchContacts(query, userId) {
  const knownResults = searchKnownProfiles(query);
  const googleResults = await searchGoogleContacts(query, userId);
  const learnedResults = await searchLearnedContacts(query, userId);

  const seen = new Set();
  const combined = [];

  for (const r of knownResults) {
    combined.push(r);
    for (const p of r.phones) seen.add(p.number);
  }

  for (const r of googleResults) {
    const isDuplicate = r.phones.some((p) => seen.has(p.number));
    if (!isDuplicate) {
      combined.push(r);
      for (const p of r.phones) seen.add(p.number);
    }
  }

  for (const r of learnedResults) {
    const isDuplicate = r.phones.some((p) => seen.has(p.number));
    if (!isDuplicate) combined.push(r);
  }

  return combined;
}

/**
 * Get a contact by exact or partial name match. Returns the best match.
 */
async function getContactByName(name, userId) {
  const results = await searchContacts(name, userId);
  if (!results.length) return null;
  return results[0];
}

module.exports = { searchContacts, getContactByName, learnContact };

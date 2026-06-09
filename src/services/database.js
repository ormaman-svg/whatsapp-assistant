'use strict';

const { Firestore } = require('@google-cloud/firestore');
const { encryptArray, decryptArray, encryptObject, decryptObject, encryptJSON, decryptJSON } = require('./crypto');

let db;

function getDb() {
  if (!db) {
    db = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      databaseId: process.env.FIRESTORE_DATABASE_ID || 'whatsapp-assistant',
    });
  }
  return db;
}

function userDoc(phoneNumber) {
  return getDb().collection('users').doc(phoneNumber);
}

// ── Profile ──

async function getProfile(phoneNumber) {
  const snap = await userDoc(phoneNumber).get();
  return snap.exists ? snap.data() : null;
}

async function setProfile(phoneNumber, data) {
  await userDoc(phoneNumber).set(data, { merge: true });
}

// ── Memory (user facts) ──

async function getMemory(phoneNumber) {
  const snap = await userDoc(phoneNumber).collection('meta').doc('memory').get();
  if (!snap.exists) return { facts: [] };
  const data = snap.data();
  return { ...data, facts: decryptArray(data.facts || [], phoneNumber) };
}

async function setMemory(phoneNumber, memoryData) {
  const toStore = { ...memoryData };
  if (toStore.facts) toStore.facts = encryptArray(toStore.facts, phoneNumber);
  await userDoc(phoneNumber).collection('meta').doc('memory').set(toStore, { merge: true });
}

async function addFacts(phoneNumber, newFacts) {
  const mem = await getMemory(phoneNumber);
  const existing = new Set(mem.facts || []);
  for (const f of newFacts) existing.add(f);
  const merged = [...existing];
  await setMemory(phoneNumber, { facts: merged, updatedAt: Firestore.FieldValue.serverTimestamp() });
  return merged;
}

async function removeFact(phoneNumber, factText) {
  const mem = await getMemory(phoneNumber);
  const facts = (mem.facts || []).filter((f) => f !== factText);
  await setMemory(phoneNumber, { facts, updatedAt: Firestore.FieldValue.serverTimestamp() });
  return facts;
}

// ── Lists (notes / to-do) ──

async function getList(phoneNumber, listName) {
  const snap = await userDoc(phoneNumber).collection('lists').doc(listName).get();
  if (!snap.exists) return { items: [] };
  const data = snap.data();
  return { ...data, items: decryptArray(data.items || [], phoneNumber) };
}

async function setList(phoneNumber, listName, data) {
  const toStore = { ...data };
  if (toStore.items) toStore.items = encryptArray(toStore.items, phoneNumber);
  await userDoc(phoneNumber).collection('lists').doc(listName).set(toStore, { merge: true });
}

async function getAllListNames(phoneNumber) {
  const snap = await userDoc(phoneNumber).collection('lists').get();
  return snap.docs.map((d) => d.id);
}

// ── Reminders ──

const REMINDER_ENCRYPTED_FIELDS = ['text', 'message'];

async function addReminder(phoneNumber, reminder) {
  const encrypted = encryptObject(reminder, phoneNumber, REMINDER_ENCRYPTED_FIELDS);
  const ref = await userDoc(phoneNumber).collection('reminders').add(encrypted);
  return ref.id;
}

async function getReminders(phoneNumber) {
  const snap = await userDoc(phoneNumber).collection('reminders').where('sent', '==', false).get();
  return snap.docs.map((d) => {
    const data = decryptObject(d.data(), phoneNumber, REMINDER_ENCRYPTED_FIELDS);
    return { id: d.id, ...data };
  });
}

async function markReminderSent(phoneNumber, reminderId) {
  await userDoc(phoneNumber).collection('reminders').doc(reminderId).update({ sent: true });
}

async function deleteReminder(phoneNumber, reminderId) {
  await userDoc(phoneNumber).collection('reminders').doc(reminderId).delete();
}

async function getDueReminders() {
  const now = Firestore.Timestamp.now();
  const allUsers = await getDb().collection('users').get();
  const due = [];
  for (const userSnap of allUsers.docs) {
    const phone = userSnap.id;
    const remSnap = await userSnap.ref
      .collection('reminders')
      .where('sent', '==', false)
      .where('triggerAt', '<=', now)
      .get();
    for (const r of remSnap.docs) {
      const data = decryptObject(r.data(), phone, REMINDER_ENCRYPTED_FIELDS);
      due.push({ id: r.id, phoneNumber: phone, ...data });
    }
  }
  return due;
}

// ── Expenses ──

const EXPENSE_ENCRYPTED_FIELDS = ['description'];

async function addExpense(phoneNumber, expense) {
  const encrypted = encryptObject(expense, phoneNumber, EXPENSE_ENCRYPTED_FIELDS);
  const ref = await userDoc(phoneNumber).collection('expenses').add({
    ...encrypted,
    createdAt: Firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function getExpenses(phoneNumber, { startDate, endDate, category } = {}) {
  let query = userDoc(phoneNumber).collection('expenses').orderBy('date', 'desc');
  if (startDate) query = query.where('date', '>=', startDate);
  if (endDate) query = query.where('date', '<=', endDate);
  const snap = await query.limit(100).get();
  let results = snap.docs.map((d) => {
    const data = decryptObject(d.data(), phoneNumber, EXPENSE_ENCRYPTED_FIELDS);
    return { id: d.id, ...data };
  });
  if (category) results = results.filter((e) => e.category === category);
  return results;
}

// ── Location ──

const LOCATION_ENCRYPTED_FIELDS = ['name', 'address', 'lat', 'lng'];

async function saveLocation(phoneNumber, location) {
  const toStore = encryptObject({
    lat: String(location.lat),
    lng: String(location.lng),
    name: location.name || null,
    address: location.address || null,
  }, phoneNumber, LOCATION_ENCRYPTED_FIELDS);
  toStore.updatedAt = Firestore.FieldValue.serverTimestamp();
  await userDoc(phoneNumber).collection('meta').doc('location').set(toStore);
}

async function getLocation(phoneNumber) {
  const snap = await userDoc(phoneNumber).collection('meta').doc('location').get();
  if (!snap.exists) return null;
  const data = decryptObject(snap.data(), phoneNumber, LOCATION_ENCRYPTED_FIELDS);
  if (data.lat) data.lat = parseFloat(data.lat);
  if (data.lng) data.lng = parseFloat(data.lng);
  const age = data.updatedAt?.toDate ? Date.now() - data.updatedAt.toDate().getTime() : Infinity;
  return { ...data, ageMs: age };
}

// ── Sessions (persistent) ──

async function saveSession(key, history) {
  const trimmed = history.slice(-150);
  const encrypted = encryptJSON(trimmed, key);
  await getDb().collection('sessions').doc(key).set({
    history: encrypted,
    encrypted: typeof encrypted === 'string',
    updatedAt: Firestore.FieldValue.serverTimestamp(),
  });
}

async function loadSession(key) {
  const snap = await getDb().collection('sessions').doc(key).get();
  if (!snap.exists) return [];
  const data = snap.data();
  if (data.encrypted && typeof data.history === 'string') {
    const decrypted = decryptJSON(data.history, key);
    return Array.isArray(decrypted) ? decrypted : [];
  }
  return Array.isArray(data.history) ? data.history : [];
}

async function deleteSession(key) {
  await getDb().collection('sessions').doc(key).delete();
}

module.exports = {
  getDb,
  Firestore,
  getProfile,
  setProfile,
  getMemory,
  setMemory,
  addFacts,
  removeFact,
  getList,
  setList,
  getAllListNames,
  addReminder,
  getReminders,
  markReminderSent,
  deleteReminder,
  getDueReminders,
  addExpense,
  getExpenses,
  saveLocation,
  getLocation,
  saveSession,
  loadSession,
  deleteSession,
};

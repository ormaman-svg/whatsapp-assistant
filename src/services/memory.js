'use strict';

const { addFacts, removeFact, getMemory } = require('./database');

async function remember(userId, facts) {
  if (!Array.isArray(facts)) facts = [facts];
  facts = facts.map((f) => f.trim()).filter(Boolean);
  if (!facts.length) return { saved: [] };
  const all = await addFacts(userId, facts);
  invalidateMemoryCache(userId);
  console.log(`[memory] Stored ${facts.length} fact(s)`);
  return { saved: facts, totalFacts: all.length };
}

async function recall(userId, query) {
  const mem = await getMemory(userId);
  const facts = mem.facts || [];
  if (!facts.length) return { facts: [], message: 'No memories stored yet.' };
  if (!query) return { facts };
  const q = query.toLowerCase();
  const matched = facts.filter((f) => f.toLowerCase().includes(q));
  return { facts: matched.length ? matched : facts, query };
}

async function forget(userId, factText) {
  const remaining = await removeFact(userId, factText);
  invalidateMemoryCache(userId);
  return { removed: factText, remainingCount: remaining.length };
}

const _memoryCache = new Map();
const MEMORY_CACHE_TTL = 5 * 60 * 1000;

async function getMemoryContext(userId) {
  const cached = _memoryCache.get(userId);
  if (cached && Date.now() - cached.ts < MEMORY_CACHE_TTL) return cached.text;

  try {
    const mem = await getMemory(userId);
    const facts = mem.facts || [];
    const text = facts.length
      ? `\nThings you remember about this user:\n${facts.map((f) => `- ${f}`).join('\n')}\nUse this knowledge naturally — don't list these facts unless asked.`
      : '';
    _memoryCache.set(userId, { text, ts: Date.now() });
    return text;
  } catch (err) {
    console.error('[memory] Failed to load memory:', err.message);
    return '';
  }
}

function invalidateMemoryCache(userId) {
  _memoryCache.delete(userId);
}

module.exports = { remember, recall, forget, getMemoryContext, invalidateMemoryCache };

'use strict';

const { getDb, getLocation } = require('./database');
const { isAuthenticated } = require('./google-auth');
const { listEvents } = require('./calendar');
const { searchEmails } = require('./gmail');
const { getDirections } = require('./maps');
const { sendText } = require('../utils/whatsapp');

const LEAD_TIME_MIN_MS = 20 * 60 * 1000;
const LEAD_TIME_MAX_MS = 35 * 60 * 1000;
const VIRTUAL_MEETING_RE = /https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex/i;
const STALE_LOCATION_MS = 6 * 60 * 60 * 1000;

// In-memory dedup — per instance, good enough at min-instances=1 (same pattern as
// the disabledProviders/processed sets elsewhere in this codebase). Worst case on
// a cold restart is one duplicate briefing, not a crash or a missed one.
const notifiedEventIds = new Set();

async function buildMeetingBriefing(userId, event) {
  const lines = [];
  const startTime = event.start
    ? new Date(event.start).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : '';
  lines.push(`📅 *פגישה בעוד כ-30 דקות* — ${startTime}`);
  lines.push(`*${event.summary || 'ללא כותרת'}*`);
  if (event.location) lines.push(`📍 ${event.location}`);

  const attendees = (event.attendees || []).filter(Boolean);
  if (attendees.length) {
    try {
      const query = attendees.map((a) => `from:${a} OR to:${a}`).join(' OR ');
      const { emails } = await searchEmails(query, 2, userId);
      if (emails?.length) {
        lines.push(`\n📧 *תכתובת אחרונה:*`);
        for (const e of emails) lines.push(`  • ${e.from}: ${e.subject}`);
      }
    } catch (err) {
      console.error('[meeting-prep] Email lookup failed:', err.message);
    }
  }

  if (event.location && !VIRTUAL_MEETING_RE.test(event.location)) {
    try {
      const loc = await getLocation(userId);
      if (loc && loc.ageMs < STALE_LOCATION_MS) {
        const origin = `${loc.lat},${loc.lng}`;
        const directions = await getDirections(origin, event.location);
        const trafficNote = directions.durationInTraffic ? ` (בפקקים: ${directions.durationInTraffic})` : '';
        lines.push(`\n🚗 נסיעה: ${directions.duration}${trafficNote}`);
      }
    } catch (err) {
      console.error('[meeting-prep] Directions lookup failed:', err.message);
    }
  }

  return lines.join('\n');
}

async function processUpcomingMeetings() {
  const now = Date.now();
  const timeMin = new Date(now + LEAD_TIME_MIN_MS).toISOString();
  const timeMax = new Date(now + LEAD_TIME_MAX_MS).toISOString();

  let sent = 0;
  try {
    const usersSnap = await getDb().collection('users').where('status', '==', 'active').get();
    for (const doc of usersSnap.docs) {
      const data = doc.data();
      if (data.plan !== 'pro' && data.plan !== 'admin') continue;
      const userId = doc.id;

      const connected = await isAuthenticated(userId).catch(() => false);
      if (!connected) continue;

      let events;
      try {
        events = await listEvents({ userId, timeMin, timeMax, maxResults: 5 });
      } catch (err) {
        console.error(`[meeting-prep] Calendar lookup failed for ${userId}:`, err.message);
        continue;
      }

      for (const event of events || []) {
        if (!event.id || notifiedEventIds.has(event.id)) continue;
        notifiedEventIds.add(event.id);
        try {
          const briefing = await buildMeetingBriefing(userId, event);
          await sendText(userId, briefing);
          sent++;
        } catch (err) {
          console.error(`[meeting-prep] Failed to send briefing for ${userId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[meeting-prep] Scan failed:', err.message);
  }

  if (notifiedEventIds.size > 5000) notifiedEventIds.clear();

  return { sent };
}

module.exports = { processUpcomingMeetings };

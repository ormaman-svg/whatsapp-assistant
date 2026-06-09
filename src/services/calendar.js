'use strict';

const { google } = require('googleapis');
const { getOAuth2ClientAsync } = require('./google-auth');

async function getCalendar(userId) {
  const auth = await getOAuth2ClientAsync(userId);
  return google.calendar({ version: 'v3', auth });
}

async function listEvents({ maxResults = 10, timeMin, timeMax, userId } = {}) {
  const calendar = await getCalendar(userId);
  const now = new Date().toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: ensureRFC3339(timeMin) || now,
    timeMax: timeMax ? ensureRFC3339(timeMax) : undefined,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: 'Asia/Jerusalem',
  });

  return (res.data.items || []).map(formatEvent);
}

function ensureRFC3339(timeStr) {
  if (!timeStr) return null;
  // Already has timezone offset or Z
  if (/[Zz]$/.test(timeStr) || /[+-]\d{2}:\d{2}$/.test(timeStr)) return timeStr;
  // Append Israel timezone offset
  return timeStr + '+03:00';
}

async function createEvent({ summary, description, startTime, endTime, location, attendees, userId }) {
  const calendar = await getCalendar(userId);

  let resolvedEnd = endTime;
  if (startTime && !resolvedEnd) {
    const start = new Date(ensureRFC3339(startTime));
    if (!Number.isNaN(start.getTime())) {
      resolvedEnd = new Date(start.getTime() + 30 * 60 * 1000).toISOString();
    }
  }

  const event = {
    summary: summary || 'פגישה',
    description: description || '',
    location: location || '',
    start: parseEventTime(startTime),
    end: parseEventTime(resolvedEnd),
  };

  if (attendees?.length) {
    event.attendees = attendees.map((email) => ({ email }));
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
    sendUpdates: attendees?.length ? 'all' : 'none',
  });

  return formatEvent(res.data);
}

async function deleteEvent(eventId, userId) {
  const calendar = await getCalendar(userId);
  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
  });
  return { deleted: true, eventId };
}

/**
 * Find upcoming events matching title/search and optional start time window.
 */
async function findMatchingEvents({ userId, search, startTime, maxResults = 25, daysAhead = 14 } = {}) {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const events = await listEvents({ userId, timeMin, timeMax, maxResults });

  const q = (search || '').trim().toLowerCase();
  if (!q && !startTime) return events;

  let matched = events;
  if (q) {
    matched = matched.filter((e) => {
      const hay = `${e.summary} ${e.description} ${e.location}`.toLowerCase();
      return hay.includes(q) || q.split(/\s+/).every((word) => word.length < 2 || hay.includes(word));
    });
  }

  if (startTime) {
    const target = new Date(ensureRFC3339(startTime));
    if (!Number.isNaN(target.getTime())) {
      const windowMs = 2 * 60 * 60 * 1000;
      const near = matched.filter((e) => {
        const start = new Date(e.start);
        return !Number.isNaN(start.getTime()) && Math.abs(start.getTime() - target.getTime()) <= windowMs;
      });
      if (near.length) matched = near;
    }
  }

  return matched;
}

/**
 * Cancel (delete) by event id or by searching title/time — what users actually say in chat.
 */
async function cancelEvent({ eventId, search, startTime, userId }) {
  if (eventId) {
    const result = await deleteEvent(eventId, userId);
    return { status: 'cancelled', ...result };
  }

  if (!search && !startTime) {
    return { error: 'Provide event_id or search (meeting title) or start_time to identify the event to cancel.' };
  }

  const matches = await findMatchingEvents({ userId, search, startTime });
  if (!matches.length) {
    return {
      error: 'לא נמצאה פגישה מתאימה ביומן. נסה לציין כותרת או שעה מדויקת יותר, או בקש "מה יש לי ביומן".',
      search: search || null,
      start_time: startTime || null,
    };
  }

  if (matches.length > 1) {
    return {
      error: 'נמצאו כמה פגישות — ציין איזו לבטל (כותרת מדויקת יותר או שעה).',
      matches: matches.map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
      })),
    };
  }

  const target = matches[0];
  await deleteEvent(target.id, userId);
  return {
    status: 'cancelled',
    deleted: true,
    eventId: target.id,
    summary: target.summary,
    start: target.start,
    end: target.end,
  };
}

async function updateEvent(eventId, updates) {
  const calendar = await getCalendar(updates?.userId);

  const patch = {};
  if (updates.summary) patch.summary = updates.summary;
  if (updates.description) patch.description = updates.description;
  if (updates.location) patch.location = updates.location;
  if (updates.startTime) patch.start = parseEventTime(updates.startTime);
  if (updates.endTime) patch.end = parseEventTime(updates.endTime);
  if (updates.attendees?.length) {
    patch.attendees = updates.attendees.map((email) => ({ email }));
  }

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: patch,
    sendUpdates: updates.attendees?.length ? 'all' : 'none',
  });

  return formatEvent(res.data);
}

function parseEventTime(timeStr) {
  if (!timeStr) {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    timeStr = d.toISOString();
  }
  // If only a date (no T), treat as all-day
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
    return { date: timeStr };
  }
  return { dateTime: timeStr, timeZone: 'Asia/Jerusalem' };
}

function formatEvent(event) {
  return {
    id: event.id,
    summary: event.summary || '(No title)',
    description: event.description || '',
    location: event.location || '',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    attendees: (event.attendees || []).map((a) => a.email),
    htmlLink: event.htmlLink || '',
  };
}

module.exports = { listEvents, createEvent, deleteEvent, updateEvent, findMatchingEvents, cancelEvent };

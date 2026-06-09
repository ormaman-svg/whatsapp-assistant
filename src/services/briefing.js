'use strict';

const { isAuthenticated } = require('./google-auth');
const { searchEmails, getUnreadCount } = require('./gmail');
const { listEvents } = require('./calendar');
const { getMemory } = require('./database');
const { getUser, updateUser } = require('./users');

// briefing preference fields on the user doc:
//   briefingEnabled: true|false|null (null = never asked, send once then ask)
//   briefingTime: "07:00" (default)

async function getBriefingPrefs(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  return {
    enabled: user.briefingEnabled ?? null,
    time: user.briefingTime || '07:00',
    plan: user.plan,
    isAdmin: user.isAdmin,
  };
}

async function setBriefingEnabled(userId, enabled) {
  await updateUser(userId, { briefingEnabled: enabled });
}

async function setBriefingTime(userId, time) {
  await updateUser(userId, { briefingTime: time, briefingEnabled: true });
}

async function buildBriefing(userId) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const sections = [];
  sections.push(`*תדריך בוקר — ${todayStr}*`);

  if (await isAuthenticated(userId)) {
    try {
      const events = await listEvents(userId, {
        timeMin: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
        timeMax: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
        maxResults: 10,
      });

      if (events?.length) {
        sections.push('\n📅 *היומן שלך היום:*');
        for (const ev of events) {
          const start = ev.start?.dateTime
            ? new Date(ev.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
            : 'כל היום';
          sections.push(`  • ${start} — ${ev.summary || 'ללא כותרת'}`);
        }
      } else {
        sections.push('\n📅 אין אירועים ביומן היום.');
      }
    } catch (err) {
      console.error('[briefing] Calendar error:', err.message);
    }

    try {
      const count = await getUnreadCount(userId);
      sections.push(`\n📧 *${count} מיילים שלא נקראו*`);

      if (count > 0) {
        const recent = await searchEmails('is:unread', userId, 5);
        for (const email of (recent || []).slice(0, 5)) {
          sections.push(`  • ${email.from}: ${email.subject}`);
        }
      }
    } catch (err) {
      console.error('[briefing] Email error:', err.message);
    }
  } else {
    sections.push('\n📧📅 חבר את חשבון Google שלך כדי לקבל סיכום מיילים ויומן.');
  }

  try {
    const mem = await getMemory(userId);
    const facts = mem?.facts || [];
    if (facts.length > 0) {
      sections.push(`\n🧠 *דברים שאני זוכר עליך:* ${facts.length} עובדות שמורות`);
    }
  } catch { /* ignore */ }

  sections.push('\nיום טוב! שלח לי הודעה אם צריך משהו.');
  return sections.join('\n');
}

module.exports = { buildBriefing, getBriefingPrefs, setBriefingEnabled, setBriefingTime };

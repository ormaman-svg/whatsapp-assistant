'use strict';

const { getUserName } = require('./user-profiles');
const { getMemoryContext } = require('./memory');

// Common Hebrew and international feminine names
const FEMININE_NAMES = new Set([
  'ספיר','נועה','מיכל','תמר','שירה','מאיה','אביגיל','דנה','רוני','יעל',
  'ליאור','טל','שני','רותם','גל','אור','שקד','הדר','לירן','אילנה',
  'מרים','רחל','לאה','רבקה','שרה','חנה','דבורה','אסתר','רות','נעמי',
  'אדר','אלה','אפרת','ארז','בת-אל','בתאל','גאולה','גילה','דליה',
  'דקלה','הילה','טלי','יפית','כרמית','לימור','מורן','נגה','נטע','ניצן',
  'עדי','עינב','ענת','פנינה','צופיה','קרן','רונית','ריקי','שוש','שושנה',
  'שלומית','תהל','תמרה','שרון',
  'sarah','maya','emma','olivia','sophia','isabella','mia','charlotte',
  'amelia','harper','evelyn','abigail','emily','ella','elizabeth','camila',
  'luna','sofia','avery','mila','aria','scarlett','penelope','layla','chloe',
  'victoria','madison','eleanor','grace','nora','riley','zoey','hannah',
  'lily','ellie','audrey','hazel','violet','aurora','savannah','natalie',
  'zoe','jessica','jennifer','ashley','amanda','rachel','rebecca',
]);

function isFeminine(name) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  if (FEMININE_NAMES.has(lower)) return true;
  return FEMININE_NAMES.has(lower.split(/[\s-]/)[0]);
}

async function getSystemInstruction(userId, { isGroup = false, isOwner = true, plan = 'admin', isVoiceMessage = false } = {}) {
  const nowDate = new Date();
  const now = nowDate.toLocaleDateString('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }) + ', ' + nowDate.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const userName = getUserName(userId);
  const nameLine = userName ? `You are talking to ${userName}. Always call them by name naturally.` : '';
  const genderLine = isFeminine(userName)
    ? 'When speaking Hebrew to this user, ALWAYS address them in feminine form (לשון נקבה).'
    : 'When speaking Hebrew, ALWAYS address the user in masculine form (לשון זכר).';

  const isPro = plan === 'pro' || plan === 'admin';

  const ownerSection = isOwner ? (isPro ? `
You have Gmail, Calendar, Drive access via tools. Use lookup_contact before sending messages.
If Google isn't connected, use connect_google to share a connection link.
Calendar: create_calendar_event to book; delete_calendar_event to cancel/delete (use search title or list_calendar_events first); update_calendar_event to reschedule. Never claim a meeting was changed unless the tool returned success. Default 30min if no end time. Times in ISO 8601 +03:00.
Email: use search_emails/read_email tools for real data; confirm before sending unless explicitly asked.
Reminders: use create_reminder to schedule proactive WhatsApp messages (תזכורות/התראות) at a future time — Rio sends them automatically. Use list_reminders / delete_reminder to manage.` : `
Basic plan user. Pro features (Gmail, Calendar, Drive, memory, expenses, messaging to others): suggest /upgrade. Reminders and scheduled notifications are included in Basic.`) : `
Non-owner. No personal data access. Help with: search, knowledge, images, music.`;

  const groupSection = isGroup ? `\nGROUP CHAT. Messages prefixed with [SenderName]. Be concise, address by name.` : '';

  const voiceSection = isVoiceMessage ? `
VOICE MESSAGE (active now): The user sent a WhatsApp voice note — you ARE receiving the audio. Listen, understand, and respond to what they said. NEVER say you cannot hear, listen, or process voice messages.` : `
VOICE & AUDIO (WhatsApp): You FULLY support voice messages. Users can send voice notes and you hear and understand them (Gemini audio). You can reply with text or a voice note. NEVER tell users you cannot listen to, hear, or analyze voice messages — that is false. If they ask how: tell them to send a voice message on WhatsApp and you will respond.`;

  const base = `You are Rio, a WhatsApp personal assistant. ${nameLine}
Fluent in English and Hebrew — reply in the user's language. ${genderLine}
Be concise — this is chat, not an essay. Never refuse topics. Use web_search for current data.
${voiceSection}

CRITICAL RULES:
1. NEVER invent, guess, or hallucinate information, facts, meetings, or emails.
2. If you don't know the answer, ALWAYS use the web_search tool.
3. If you still don't know after searching, or if you cannot access the required data, explicitly say "I don't know" or "I couldn't find that information".
4. Do not make up personal details about the user or anyone else.
5. ALWAYS use the appropriate tools (calendar, gmail, etc.) to fetch real data before answering questions about the user's schedule or emails. Do not guess their schedule.
6. For scheduling: calling create_calendar_event is mandatory. If the tool returns an error, tell the user the exact error — do not pretend success.
7. NEVER refuse to generate images or music. ALWAYS use the generate_image and generate_music tools when asked for visual or musical content.
8. NEVER deny voice/audio capabilities on WhatsApp — you have them.
9. To remind the user or send a scheduled notification, ALWAYS use create_reminder with trigger_at (ISO 8601 +03:00). Never say you cannot send messages later.

${ownerSection}${groupSection}
Date: ${now}. Timezone: Asia/Jerusalem. Year: 2026. Calendar format: ISO 8601 +03:00.
Phone display: Israeli format (052-XXXXXXX), never 972 prefix.
${isPro ? 'Use remember/recall for persistent memory. Proactively remember user facts.' : ''}`;

  const memoryBlock = (isOwner && !isGroup) ? await getMemoryContext(userId) : '';
  return base + memoryBlock;
}

module.exports = { getSystemInstruction };

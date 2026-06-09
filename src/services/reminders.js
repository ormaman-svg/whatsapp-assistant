'use strict';

const { addReminder, getReminders, deleteReminder, markReminderSent, getDueReminders, Firestore } = require('./database');
const { sendText } = require('../utils/whatsapp');

async function createReminder(userId, { text, triggerAt, recurring, targetNumber }) {
  const triggerDate = new Date(triggerAt);
  if (Number.isNaN(triggerDate.getTime())) {
    throw new Error(`Invalid trigger_at: ${triggerAt}`);
  }
  if (triggerDate.getTime() <= Date.now() - 60_000) {
    throw new Error('trigger_at must be in the future');
  }

  const reminder = {
    text,
    triggerAt: Firestore.Timestamp.fromDate(triggerDate),
    recurring: recurring || null,
    targetNumber: targetNumber || null,
    sent: false,
    createdAt: Firestore.FieldValue.serverTimestamp(),
  };
  const id = await addReminder(userId, reminder);
  const recurringLabel = recurring?.type || 'none';
  console.log(`[reminders] Scheduled id=${id} at=${triggerDate.toISOString()} recurring=${recurringLabel}`);
  return { id, text, triggerAt: triggerDate.toISOString(), recurring: recurringLabel };
}

async function listReminders(userId) {
  const reminders = await getReminders(userId);
  return reminders.map((r) => ({
    id: r.id,
    text: r.text,
    triggerAt: r.triggerAt?.toDate?.() ? r.triggerAt.toDate().toISOString() : r.triggerAt,
    recurring: r.recurring || 'none',
    targetNumber: r.targetNumber || null,
  }));
}

async function removeReminder(userId, reminderId) {
  await deleteReminder(userId, reminderId);
  return { deleted: reminderId };
}

async function processDueReminders() {
  const due = await getDueReminders();
  let processed = 0;

  for (const reminder of due) {
    try {
      const target = reminder.targetNumber || reminder.phoneNumber;
      const prefix = reminder.targetNumber
        ? `⏰ הודעה מ-Rio (מ${reminder.phoneNumber?.slice(-4) || 'משתמש'}):\n`
        : '⏰ תזכורת מ-Rio:\n';
      await sendText(target, `${prefix}${reminder.text}`);
      const masked = target.length > 5 ? target.slice(0, 3) + '***' + target.slice(-3) : '***';
      console.log(`[reminders] Sent reminder to ${masked}`);

      if (reminder.recurring) {
        const next = computeNextTrigger(reminder.triggerAt, reminder.recurring);
        if (next) {
          await addReminder(reminder.phoneNumber, {
            text: reminder.text,
            triggerAt: Firestore.Timestamp.fromDate(next),
            recurring: reminder.recurring,
            targetNumber: reminder.targetNumber || null,
            sent: false,
          });
        }
      }

      await markReminderSent(reminder.phoneNumber, reminder.id);
      processed++;
    } catch (err) {
      console.error(`[reminders] Failed to process reminder ${reminder.id}:`, err.message);
    }
  }

  return { processed, total: due.length };
}

function computeNextTrigger(currentTrigger, recurring) {
  const date = currentTrigger?.toDate ? currentTrigger.toDate() : new Date(currentTrigger);
  if (!recurring?.type) return null;

  switch (recurring.type) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      return date;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      return date;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      return date;
    default:
      return null;
  }
}

module.exports = { createReminder, listReminders, removeReminder, processDueReminders };

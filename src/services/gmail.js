'use strict';

const { google } = require('googleapis');
const { getOAuth2ClientAsync } = require('./google-auth');

async function getGmail(userId) {
  const auth = await getOAuth2ClientAsync(userId);
  return google.gmail({ version: 'v1', auth });
}

async function searchEmails(query, maxResults = 5, userId) {
  const gmail = await getGmail(userId);
  // Strip invalid Gmail operators that Gemini sometimes adds
  const cleanQuery = query
    .replace(/\b(sort|order|newest_first|oldest_first)[:\s]\S*/gi, '')
    .replace(/\b(newest_first|oldest_first)\b/gi, '')
    .trim() || 'in:inbox';

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: cleanQuery,
    maxResults,
  });

  if (!res.data.messages?.length) {
    return { count: 0, emails: [] };
  }

  const emails = await Promise.all(
    res.data.messages.map((m) => getEmailSummary(gmail, m.id))
  );

  return { count: res.data.resultSizeEstimate || emails.length, emails };
}

async function getEmailSummary(gmail, messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });

  const headers = res.data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || '';

  return {
    id: messageId,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    snippet: res.data.snippet || '',
  };
}

async function readEmail(messageId, userId) {
  const gmail = await getGmail(userId);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = res.data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || '';

  let body = '';
  const payload = res.data.payload;
  if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  } else if (payload.parts) {
    const textPart = payload.parts.find(
      (p) => p.mimeType === 'text/plain' && p.body?.data
    );
    if (textPart) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
    } else {
      const htmlPart = payload.parts.find(
        (p) => p.mimeType === 'text/html' && p.body?.data
      );
      if (htmlPart) {
        body = Buffer.from(htmlPart.body.data, 'base64')
          .toString('utf8')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }

  // Truncate very long emails
  if (body.length > 3000) body = body.substring(0, 3000) + '... [truncated]';

  return {
    id: messageId,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    body,
  };
}

async function sendEmail(to, subject, body, userId) {
  const gmail = await getGmail(userId);

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return { messageId: res.data.id, threadId: res.data.threadId };
}

async function getUnreadCount(userId) {
  const gmail = await getGmail(userId);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 1,
  });
  return res.data.resultSizeEstimate || 0;
}

module.exports = { searchEmails, readEmail, sendEmail, getUnreadCount };

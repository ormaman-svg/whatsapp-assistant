'use strict';

const axios = require('axios');
const { getDb, Firestore } = require('./database');
const { hmacSign, hmacVerify, encryptJSON, decryptJSON } = require('./crypto');

/**
 * Slack integration via Bot Token or per-user OAuth.
 * Env: SLACK_BOT_TOKEN (global), or per-user tokens in Firestore.
 * OAuth: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET for per-user auth.
 */

async function getSlackToken(userId) {
  try {
    const snap = await getDb().collection('users').doc(userId).collection('meta').doc('slack').get();
    if (snap.exists) {
      const raw = snap.data();
      if (raw.encrypted && typeof raw.data === 'string') {
        const decrypted = decryptJSON(raw.data, userId);
        if (decrypted?.accessToken) return decrypted.accessToken;
      } else if (raw.accessToken) {
        return raw.accessToken;
      }
    }
  } catch { /* ignore */ }

  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  return null;
}

async function saveSlackToken(userId, data) {
  const tokenData = {
    accessToken: data.access_token,
    teamId: data.team?.id,
    teamName: data.team?.name,
    scope: data.scope,
  };
  const encrypted = encryptJSON(tokenData, userId);
  const payload = typeof encrypted === 'string'
    ? { encrypted: true, data: encrypted, connectedAt: Firestore.FieldValue.serverTimestamp() }
    : { ...tokenData, connectedAt: Firestore.FieldValue.serverTimestamp() };
  await getDb().collection('users').doc(userId).collection('meta').doc('slack').set(payload);
}

async function slackApi(method, token, params = {}) {
  const { data } = await axios.post(`https://slack.com/api/${method}`, params, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    timeout: 10000,
  });
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

async function getUnreadMessages(userId) {
  const token = await getSlackToken(userId);
  if (!token) return { error: 'Slack not connected.', setup: getSetupMessage(userId) };

  const data = await slackApi('conversations.list', token, {
    types: 'im,mpim,public_channel,private_channel',
    exclude_archived: true,
    limit: 20,
  });

  const unread = [];
  for (const ch of (data.channels || [])) {
    if (ch.unread_count > 0) {
      unread.push({
        channel: ch.name || ch.id,
        type: ch.is_im ? 'DM' : ch.is_group ? 'group' : 'channel',
        unreadCount: ch.unread_count,
      });
    }
  }

  return { unreadChannels: unread, total: unread.reduce((s, c) => s + c.unreadCount, 0) };
}

async function getRecentMessages(userId, channelQuery) {
  const token = await getSlackToken(userId);
  if (!token) return { error: 'Slack not connected.', setup: getSetupMessage(userId) };

  let channelId = channelQuery;

  if (!channelQuery.startsWith('C') && !channelQuery.startsWith('D') && !channelQuery.startsWith('G')) {
    const list = await slackApi('conversations.list', token, {
      types: 'im,mpim,public_channel,private_channel',
      limit: 100,
    });
    const match = (list.channels || []).find((c) =>
      c.name?.toLowerCase() === channelQuery.toLowerCase()
    );
    if (match) channelId = match.id;
    else return { error: `Channel "${channelQuery}" not found.` };
  }

  const history = await slackApi('conversations.history', token, {
    channel: channelId,
    limit: 10,
  });

  const messages = [];
  for (const msg of (history.messages || [])) {
    messages.push({
      user: msg.user || 'bot',
      text: msg.text?.substring(0, 300),
      timestamp: new Date(parseFloat(msg.ts) * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }),
    });
  }

  return { channel: channelQuery, messages: messages.reverse() };
}

async function sendSlackMessage(userId, channel, text) {
  const token = await getSlackToken(userId);
  if (!token) return { error: 'Slack not connected.', setup: getSetupMessage(userId) };

  let channelId = channel;
  if (!channel.startsWith('C') && !channel.startsWith('D') && !channel.startsWith('G')) {
    const list = await slackApi('conversations.list', token, {
      types: 'im,mpim,public_channel,private_channel',
      limit: 100,
    });
    const match = (list.channels || []).find((c) =>
      c.name?.toLowerCase() === channel.toLowerCase()
    );
    if (match) channelId = match.id;
    else return { error: `Channel "${channel}" not found.` };
  }

  await slackApi('chat.postMessage', token, {
    channel: channelId,
    text,
  });

  return { status: 'Message sent', channel };
}

function getSetupMessage(userId) {
  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
  const sig = hmacSign(userId, 'slack-connect');
  const url = sig ? `${serviceUrl}/slack/connect?user=${userId}&sig=${sig}` : `${serviceUrl}/slack/connect?user=${userId}`;
  return `To connect Slack, open: ${url}`;
}

function isSlackConfigured() {
  return !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

function getSlackAuthUrl(userId) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
  const redirectUri = `${serviceUrl}/slack/callback`;
  const scopes = 'channels:read,channels:history,chat:write,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read';
  const sig = hmacSign(userId, 'slack-oauth');
  const state = sig ? `${userId}.${sig}` : userId;
  return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
}

function parseSlackOAuthState(state) {
  if (!state) return null;
  const dotIdx = state.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const userId = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  if (!hmacVerify(userId, 'slack-oauth', sig)) return null;
  return userId;
}

async function handleSlackOAuthCallback(code, userId) {
  const { data } = await axios.post('https://slack.com/api/oauth.v2.access', null, {
    params: {
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000'}/slack/callback`,
    },
  });
  if (!data.ok) throw new Error(`Slack OAuth failed: ${data.error}`);
  await saveSlackToken(userId, data);
  return data.team?.name || 'Slack workspace';
}

module.exports = {
  getUnreadMessages,
  getRecentMessages,
  sendSlackMessage,
  isSlackConfigured,
  getSlackAuthUrl,
  handleSlackOAuthCallback,
  parseSlackOAuthState,
  getSlackToken,
};

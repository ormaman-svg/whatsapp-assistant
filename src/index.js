'use strict';

require('dotenv').config();

process.on('uncaughtException', (err) => {
  if (/Unsupported state or unable to authenticate data/.test(err.message)) {
    console.error('[process] Noise protocol decryption error (non-fatal, ignoring):', err.message);
    return;
  }
  console.error('[process] Uncaught exception:', err);
  process.exit(1);
});

const _origInfo = console.info;
const _origWarn = console.warn;
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Closing session')) return;
  _origInfo.apply(console, args);
};
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Session already closed')) return;
  _origWarn.apply(console, args);
};

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const QRCode = require('qrcode');
const { isAllowed, getActiveUser, getAnyUser } = require('./middleware/whitelist');

function maskPhone(phone) {
  if (!phone || phone.length < 6) return '***';
  return phone.slice(0, 3) + '***' + phone.slice(-3);
}

const DEFAULT_ROUTE_ERROR =
  'Something went wrong. Please try again.\nמשהו השתבש, אנא נסה שוב.';

/** Turn known upstream failures into a clear WhatsApp reply (Gemini quota/billing is a common case). */
function userFacingRouteError(err) {
  const m = String(err?.message || '');
  const gemini = /generativelanguage\.googleapis|GoogleGenerativeAI/i.test(m);
  if (!gemini) return null;

  if (/429|Too Many Requests/i.test(m)) {
    if (/prepayment credits are depleted|credits are depleted|RESOURCE_EXHAUSTED|billing|quota/i.test(m)) {
      return (
        'Gemini: prepaid credits are depleted or the API quota was hit. The admin should add credits in Google AI Studio (https://aistudio.google.com) or billing, and check GEMINI_API_KEY on Cloud Run.\n\n' +
        'נגמרה היתרה ל-Gemini (קרדיטים או מכסה). צריך לטעון יתרה ב-AI Studio / חיוב בגוגל, ולבדוק את GEMINI_API_KEY ב-Cloud Run.'
      );
    }
    return (
      'The AI is temporarily rate-limited. Try again in a minute.\n\n' +
      'המודל מוגבל כרגע. נסה שוב בעוד דקה.'
    );
  }

  if (/401|403|API key not valid|invalid API key|PERMISSION_DENIED/i.test(m)) {
    return (
      'Gemini API key is missing or invalid. Ask the admin to set GEMINI_API_KEY in Cloud Run.\n\n' +
      'מפתח Gemini חסר או לא תקין — יש להגדיר GEMINI_API_KEY ב-Cloud Run.'
    );
  }

  return null;
}

const {
  sendText,
  markRead,
  downloadMedia,
  uploadMedia,
  sendAudio,
  sendImage,
  sendSticker,
  sendDocument,
  sendVideo,
  sendGroupMessage,
  sendGroupImage,
  sendGroupAudio,
  fetchRioPhoneNumber,
  formatPhoneForDisplay,
} = require('./utils/whatsapp');
const { initBaileys, getConnectionState, getLastQR, updateProfilePicture, updateProfileName, updateProfileAbout } = require('./services/baileys');
const { getPNForLID } = require('./services/baileys-auth');
const { pcmBufferToOgg, cleanFile } = require('./utils/audio');
const {
  handleText: geminiHandleText,
  handleImage,
  handleAudioToText,
  handleAudioToAudio,
} = require('./services/gemini');
const {
  parseModelCommand,
  chatWithProvider,
  getAvailableModels,
  getUserModel,
  isProviderConfigured,
} = require('./services/model-router');
const { addToHistory, getHistory, groupKey, addGroupMessage, getGroupHistory } = require('./services/session');
const { isAllowed: isOwnerNumber } = require('./middleware/whitelist');
const { learnContact } = require('./services/contacts');
const { storeUserImage } = require('./services/tools');
const { createCheckoutSession, createPortalSession, getSubscriptionStatus, handleWebhookEvent, constructEvent } = require('./services/billing');
const { getUser, createUser, activateUser, updateOnboardingStep, getUserPlan, isAdmin, PLANS } = require('./services/users');
const { hmacSign } = require('./services/crypto');

function signedOAuthUrl(userId) {
  const base = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
  const sig = hmacSign(userId, 'oauth-start');
  return sig ? `${base}/oauth/start?user=${userId}&sig=${sig}` : `${base}/oauth/start?user=${userId}`;
}

const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"] } },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
  skip: (req) => req.path === '/health' || req.path.startsWith('/admin/'),
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Stripe webhook needs raw body for signature verification -- must be before express.json()
app.post('/stripe/webhook', webhookLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = constructEvent(req.body, sig);
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Webhook error:', err.message);
    res.status(400).send('Webhook signature verification failed');
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Pairing before global rate limit — page used to auto-reload every 3s (floods /admin).
app.get('/admin/pair', requireAdminToken, async (req, res) => {
  const state = getConnectionState();
  const qrString = getLastQR();
  let qrDataUrl = null;

  if (qrString) {
    try {
      qrDataUrl = await QRCode.toDataURL(qrString, { width: 300, margin: 2 });
    } catch { /* ignore */ }
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rio — Pairing</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
.card{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:420px}
h1{font-size:1.4em;margin-bottom:8px}
.status{color:#666;margin:10px 0}
.qr{margin:20px 0}
.instructions{text-align:left;color:#444;line-height:1.8;margin-top:20px}
.refresh{margin-top:20px;padding:10px 24px;background:#25D366;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1em}
</style></head><body><div class="card">
<h1>Rio WhatsApp Pairing</h1>
<p class="status">Connection: <strong>${state}</strong></p>
${state === 'open' ? '<p style="font-size:2em;margin:20px 0">Connected!</p>' :
  qrDataUrl ? `<p>Scan this QR code with WhatsApp:</p>
<div class="qr"><img src="${qrDataUrl}" alt="QR Code" style="border-radius:8px"/></div>
<div class="instructions">
<strong>Steps:</strong><br>
1. Open WhatsApp Business on your phone<br>
2. Go to <strong>Settings > Linked Devices</strong><br>
3. Tap <strong>Link a Device</strong><br>
4. Point your camera at the QR code above
</div>` :
  `<p>ממתינים ל-QR… לחץ <strong>Refresh</strong> כל כמה שניות (בלי רענון אוטומטי כדי לא לחסום את השרת).</p>`}
<button class="refresh" onclick="location.reload()">Refresh</button>
</div></body></html>`);
});

app.use(apiLimiter);

const processed = new Set();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(msgId) {
  if (processed.has(msgId)) return true;
  processed.add(msgId);
  setTimeout(() => processed.delete(msgId), DEDUP_TTL_MS);
  return false;
}

function requireAdminToken(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || typeof token !== 'string') return res.status(403).json({ error: 'Forbidden' });
  const a = Buffer.from(adminToken);
  const b = Buffer.from(token);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ---------- Baileys incoming message handler ----------
const lidCache = new Map();

async function resolveJidToPhone(jid) {
  if (!jid) return '';
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '');
  if (!jid.endsWith('@lid')) return jid;

  const lidUser = jid.split('@')[0].split(':')[0];
  if (lidCache.has(lidUser)) return lidCache.get(lidUser);

  const pnUser = await getPNForLID(jid);
  if (pnUser) {
    lidCache.set(lidUser, pnUser);
    console.log(`[lid] Resolved LID → ${maskPhone(pnUser)}`);
    return pnUser;
  }

  console.warn(`[lid] No phone mapping for ${jid} — using LID as identifier`);
  lidCache.set(lidUser, lidUser);
  return lidUser;
}

async function handleBaileysMessage(m) {
  try {
    if (!m.message) return;
    if (m.key.fromMe) return;

    const isGroup = m.key.remoteJid?.endsWith('@g.us') || false;
    const rawJid = isGroup
      ? (m.key.participant || '')
      : (m.key.remoteJid || '');
    const from = await resolveJidToPhone(rawJid);

    if (!from) return;
    const groupId = isGroup ? m.key.remoteJid : null;
    const msgId = m.key.id;

    if (m.pushName && from) {
      learnContact(from, m.pushName, from).catch(() => {});
    }

    const raw = m.message;
    let msg;

    const contextInfo = raw.extendedTextMessage?.contextInfo || raw.imageMessage?.contextInfo || raw.audioMessage?.contextInfo || null;

    if (raw.conversation || raw.extendedTextMessage) {
      msg = { type: 'text', text: { body: raw.conversation || raw.extendedTextMessage?.text || '' }, contextInfo };
    } else if (raw.imageMessage) {
      msg = { type: 'image', image: { id: m, caption: raw.imageMessage.caption || '' } };
    } else if (raw.audioMessage) {
      msg = { type: 'audio', audio: { id: m } };
    } else if (raw.documentMessage) {
      msg = {
        type: 'document',
        document: {
          id: m,
          filename: raw.documentMessage.fileName || 'document',
          mime_type: raw.documentMessage.mimetype || 'application/octet-stream',
          caption: raw.documentMessage.caption || '',
        },
      };
    } else if (raw.locationMessage) {
      msg = {
        type: 'location',
        location: {
          latitude: raw.locationMessage.degreesLatitude,
          longitude: raw.locationMessage.degreesLongitude,
          name: raw.locationMessage.name || '',
          address: raw.locationMessage.address || '',
        },
      };
    } else {
      return;
    }

    if (isDuplicate(msgId)) return;
    markRead(m.key).catch(() => {});

    if (groupId) {
      const { getSocket } = require('./services/baileys');
      const rioJid = getSocket()?.user?.id || '';
      const contactInfo = { profile: { name: m.pushName || '' } };
      await routeGroupMessage(from, groupId, msg, contactInfo, rioJid);
    } else {
      const activeUser = await getActiveUser(from);
      if (activeUser) {
        await routeMessage(from, msg, activeUser);
      } else {
        await handleOnboarding(from, msg);
      }
    }
  } catch (err) {
    console.error('[baileys] Unhandled message error:', err.message);
  }
}

async function routeMessage(from, msg, user) {
  try {
    const plan = getUserPlan(user)?.name?.toLowerCase() || 'basic';
    // Text path must receive the same plan as image/audio (from getUserPlan), not only user.plan from Firestore.
    const routeCtx = { user, plan };
    const routeOpts = { plan };
    switch (msg.type) {
      case 'text':
        await onText(from, msg, routeCtx);
        break;
      case 'image':
        await onImage(from, msg, routeOpts);
        break;
      case 'audio':
        await onAudio(from, msg, routeOpts);
        break;
      case 'document':
        await onDocument(from, msg, routeOpts);
        break;
      case 'location':
        await onLocation(from, msg, routeOpts);
        break;
      default:
        await sendText(
          from,
          'Sorry, I can only handle text, images, voice, and document messages for now.\nאני יכול לטפל בטקסט, תמונות, הודעות קוליות ומסמכים.'
        );
    }
  } catch (err) {
    const errDetail = err.response?.data
      ? JSON.stringify(err.response.data).substring(0, 300)
      : '';
    const stack = err.stack ? String(err.stack).substring(0, 800) : '';
    console.error(`[route] Error processing ${msg.type} from ${maskPhone(from)}:`, err.message, errDetail, stack || '');
    const userMsg = userFacingRouteError(err) || DEFAULT_ROUTE_ERROR;
    await sendText(from, userMsg).catch(() => {});
  }
}

// ---------- Group message routing ----------
const RIO_MENTIONS = /\brio\b|ריו/i;

function shouldRespondInGroup(msg, rioJid) {
  const text = msg.text?.body || msg.image?.caption || '';
  if (RIO_MENTIONS.test(text)) return true;

  const ctx = msg.contextInfo || msg.text?.contextInfo;
  if (ctx) {
    const mentionedJids = ctx.mentionedJid || [];
    if (rioJid && mentionedJids.some(j => j === rioJid || j.includes(rioJid.split('@')[0]))) return true;

    if (ctx.quotedMessage && ctx.participant) {
      const quotedIsRio = ctx.participant === rioJid || ctx.participant?.includes(rioJid?.split('@')[0] || '___');
      if (quotedIsRio) return true;
    }

    if (ctx.stanzaId && ctx.participant === rioJid) return true;
  }
  return false;
}

async function routeGroupMessage(from, groupId, msg, contactInfo, rioJid) {
  try {
    if (!shouldRespondInGroup(msg, rioJid)) return;

    const senderName = contactInfo?.profile?.name || from;
    const ownerFlag = isAllowed(from);
    const sessionKey = groupKey(groupId);

    const senderUser = await getActiveUser(from);
    const senderPlan = senderUser ? (getUserPlan(senderUser)?.name?.toLowerCase() || 'basic') : 'basic';

    console.log(`[group] ${maskPhone(from)} in group (plan=${senderPlan}): ${msg.type}`);

    switch (msg.type) {
      case 'text': {
        const text = msg.text?.body?.trim();
        if (!text) return;

        const cleanText = text.replace(RIO_MENTIONS, '').trim() || text;
        const prefixed = `[${senderName}] ${cleanText}`;

        const opts = { isGroup: true, isOwner: ownerFlag, sessionKey, plan: senderPlan };

        const { text: reply, media } = await geminiHandleText(from, prefixed, opts);

        await sendGroupMediaResults(groupId, media);
        if (reply) await sendGroupMessage(groupId, reply);
        break;
      }
      case 'image': {
        const mediaId = msg.image?.id;
        if (!mediaId) return;
        const { buffer, mimeType } = await downloadMedia(mediaId);
        storeUserImage(from, buffer, mimeType);
        const caption = msg.image?.caption || '';
        const opts = { isGroup: true, isOwner: ownerFlag, sessionKey, plan: senderPlan };
        const { text: reply, media } = await handleImage(from, buffer, mimeType, caption, opts);
        await sendGroupMediaResults(groupId, media);
        if (reply) await sendGroupMessage(groupId, reply);
        break;
      }
      case 'audio': {
        const audioId = msg.audio?.id;
        if (!audioId) return;
        const { buffer, mimeType } = await downloadMedia(audioId);
        try {
          const { textReply, pcmBase64 } = await handleAudioToAudio(from, buffer, mimeType, { isGroup: true, sessionKey, plan: senderPlan });
          const pcmBuffer = Buffer.from(pcmBase64, 'base64');
          const oggPath = await pcmBufferToOgg(pcmBuffer);
          const media = await uploadMedia(oggPath, 'audio/ogg; codecs=opus');
          await sendGroupAudio(groupId, media);
          cleanFile(oggPath);
        } catch {
          const textReply = await handleAudioToText(from, buffer, mimeType, { isGroup: true, sessionKey, plan: senderPlan });
          if (textReply) await sendGroupMessage(groupId, textReply);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : '';
    console.error(`[group] Error processing ${msg.type} in ${groupId}:`, err.message, errDetail);
    const userMsg = userFacingRouteError(err) || 'Something went wrong. Try again.\nמשהו השתבש, נסו שוב.';
    await sendGroupMessage(groupId, userMsg).catch(() => {});
  }
}

async function sendGroupMediaResults(groupId, mediaItems) {
  if (!mediaItems?.length) return;
  for (const item of mediaItems) {
    try {
      const media = await uploadMedia(item.path, item.mimeType);
      if (item.type === 'image') {
        await sendGroupImage(groupId, media);
      } else if (item.type === 'audio') {
        await sendGroupAudio(groupId, media);
      } else if (item.type === 'sticker') {
        await sendSticker(groupId, media);
      } else if (item.type === 'video') {
        await sendVideo(groupId, media, item.filename || 'video.mp4');
      } else if (item.type === 'document') {
        await sendDocument(groupId, media, item.filename || 'document.pdf', '');
      }
    } catch (err) {
      console.error(`[group-media] Failed to send ${item.type}:`, err.message);
    } finally {
      cleanFile(item.path);
    }
  }
}

// ---------- Text messages ----------
async function onText(from, msg, opts = {}) {
  const text = msg.text?.body?.trim();
  if (!text) return;

  const lowerText = text.toLowerCase();

  if (lowerText === '/clear') {
    const { clearSession } = require('./services/session');
    clearSession(opts.sessionKey || from);
    await sendText(from, 'Session cleared. / ההיסטוריה נמחקה.');
    return;
  }

  // --- Subscription commands ---
  if (lowerText === '/plan') {
    await handlePlanCommand(from, opts.user);
    return;
  }
  if (lowerText === '/upgrade' || lowerText === '/billing') {
    await handleBillingCommand(from, opts.user, lowerText);
    return;
  }
  if (lowerText.startsWith('/briefing')) {
    await handleBriefingCommand(from, lowerText);
    return;
  }

  if (lowerText === 'כן' || lowerText === 'לא') {
    const { getBriefingPrefs, setBriefingEnabled } = require('./services/briefing');
    const prefs = await getBriefingPrefs(from);
    if (prefs?.enabled === 'asked') {
      if (lowerText === 'כן') {
        await setBriefingEnabled(from, true);
        await sendText(from, 'מעולה! תקבל תדריך בוקר כל יום ב-07:00.\nלשנות שעה: /briefing 08:30');
      } else {
        await setBriefingEnabled(from, false);
        await sendText(from, 'הבנתי, לא אשלח תדריך אוטומטי.\nאתה תמיד יכול לבקש ידנית: "תדריך בוקר"');
      }
      return;
    }
  }

  const { providerName, message, isCommand } = parseModelCommand(from, text);

  if (isCommand === 'list') {
    const models = getAvailableModels();
    const current = getUserModel(from);
    const lines = models.map((m) => {
      const status = m.configured ? '' : ' (no API key)';
      const active = m.name === current ? ' ← active' : '';
      return `• *${m.display}*${status}${active}\n  prefix: \`${m.prefix}\``;
    });
    await sendText(from, `Available models:\n\n${lines.join('\n\n')}\n\nSwitch default: /model gpt\nOne-time: gpt: your question`);
    return;
  }

  if (isCommand === 'switched') {
    const display = getAvailableModels().find((m) => m.name === providerName)?.display || providerName;
    if (!isProviderConfigured(providerName)) {
      await sendText(from, `${display} selected, but the API key is not configured yet. Ask the admin to add it.\n\nנבחר ${display}, אבל מפתח ה-API עדיין לא הוגדר.`);
    } else {
      await sendText(from, `Switched to *${display}*\nהמודל שונה ל-*${display}*`);
    }
    return;
  }

  if (isCommand === 'unknown_model') {
    await sendText(from, `Unknown model. Type /models to see available options.\nמודל לא מוכר. הקלד /models לרשימה.`);
    return;
  }

  const userMessage = message || text;
  const sessionKey = opts.sessionKey || from;
  const isOwner = opts.isOwner !== undefined ? opts.isOwner : isOwnerNumber(from);
  const userPlan = opts.plan !== undefined && opts.plan !== null
    ? opts.plan
    : (opts.user ? opts.user.plan : null);
  const routeOpts = { isGroup: opts.isGroup || false, isOwner, sessionKey, plan: userPlan };
  console.log(`[text] ${maskPhone(from)} [${providerName}] len=${userMessage.length}`);

  if (providerName === 'gemini') {
    const { text: reply, media } = await geminiHandleText(from, userMessage, routeOpts);

    if (reply && isRefusal(reply)) {
      const fallback = getFallbackProvider();
      if (fallback) {
        console.log(`[fallback] Gemini refused, retrying with ${fallback}`);
        try {
          const history = getHistory(sessionKey);
          const { text: fbReply, media: fbMedia } = await chatWithProvider(fallback, from, userMessage, history, routeOpts);
          addToHistory(sessionKey, 'model', [{ text: fbReply }]);
          await sendMediaResults(from, fbMedia);
          if (fbReply) await sendText(from, fbReply);
          return;
        } catch (fbErr) {
          handleProviderError(fbErr, fallback);
        }
      }
    }

    await sendMediaResults(from, media);
    if (reply) await sendText(from, reply);
  } else {
    if (!isProviderConfigured(providerName)) {
      const display = getAvailableModels().find((m) => m.name === providerName)?.display || providerName;
      await sendText(from, `${display} API key not configured. Falling back to Gemini.\nמפתח API של ${display} לא הוגדר. חוזר לג'מיני.`);
      const { text: reply, media } = await geminiHandleText(from, userMessage, routeOpts);
      await sendMediaResults(from, media);
      if (reply) await sendText(from, reply);
      return;
    }

    const history = getHistory(sessionKey);

    try {
      const { text: reply, media } = await chatWithProvider(providerName, from, userMessage, history, routeOpts);

      addToHistory(sessionKey, 'user', [{ text: userMessage }]);
      addToHistory(sessionKey, 'model', [{ text: reply }]);

      if (reply && isRefusal(reply)) {
        console.log(`[fallback] ${providerName} refused, retrying with gemini`);
        const { text: fbReply, media: fbMedia } = await geminiHandleText(from, userMessage, routeOpts);
        await sendMediaResults(from, fbMedia);
        if (fbReply) await sendText(from, fbReply);
        return;
      }

      await sendMediaResults(from, media);
      if (reply) await sendText(from, reply);
    } catch (err) {
      handleProviderError(err, providerName);
      console.log(`[fallback] ${providerName} failed, falling back to gemini`);
      const { text: reply, media } = await geminiHandleText(from, userMessage, routeOpts);
      await sendMediaResults(from, media);
      if (reply) await sendText(from, reply);
    }
  }
}

function isRefusal(text) {
  const patterns = [
    /אני מודל שפה ולא (יכול|מסוגל)/i,
    /I'm just a (text|language) model/i,
    /אני לא יועץ (פיננסי|רפואי|משפטי)/i,
    /I am not (a financial|a medical|a legal) advisor/i,
    /אסור לי לספק/i,
    /לא (יכול|מסוגל|יודע).{0,40}(להאזין|לשמוע|הודעות קול)/i,
    /אני לא (יכול|מסוגל).{0,40}(להאזין|לשמוע|קול)/i,
    /cannot (listen|hear).{0,30}(voice|audio)/i,
    /can't (listen|hear).{0,30}(voice|audio)/i,
  ];
  return patterns.some((p) => p.test(text));
}

const disabledProviders = new Set();

function handleProviderError(err, providerName) {
  const isQuota = /quota|insufficient|exceeded|billing|credit/i.test(err.message);
  if (isQuota) {
    console.warn(`[fallback] ${providerName} quota exceeded, disabling`);
    disabledProviders.add(providerName);
  }
  console.error(`[fallback] ${providerName} failed:`, err.message);
}

function getFallbackProvider() {
  const fallbackOrder = ['openai', 'anthropic', 'xai'];
  return fallbackOrder.find((p) => isProviderConfigured(p) && !disabledProviders.has(p)) || null;
}

// ---------- Image messages ----------
async function onImage(from, msg, opts = {}) {
  const mediaId = msg.image?.id;
  if (!mediaId) return;

  console.log(`[image] ${maskPhone(from)}`);
  const { buffer, mimeType } = await downloadMedia(mediaId);
  storeUserImage(from, buffer, mimeType);
  const caption = msg.image?.caption || '';
  const { text: reply, media } = await handleImage(from, buffer, mimeType, caption, opts);
  await sendMediaResults(from, media);
  if (reply) await sendText(from, reply);
}

// ---------- Document messages ----------
async function onDocument(from, msg, opts = {}) {
  const mediaId = msg.document?.id;
  if (!mediaId) return;

  const filename = msg.document?.filename || 'document';
  const docMime = msg.document?.mime_type || 'application/octet-stream';
  const caption = msg.document?.caption || '';
  console.log(`[document] ${maskPhone(from)}: ${filename}`);

  const { buffer, mimeType } = await downloadMedia(mediaId);
  const prompt = caption || `Analyze this document (${filename}) and provide a helpful summary.`;

  const textContent = extractDocumentText(buffer, mimeType, filename);

  if (textContent) {
    const fullPrompt = `${prompt}\n\nDocument content (${filename}):\n\`\`\`\n${textContent}\n\`\`\``;
    const { text: reply, media } = await geminiHandleText(from, fullPrompt, opts);
    await sendMediaResults(from, media);
    if (reply) await sendText(from, reply);
  } else {
    const { text: reply, media } = await handleImage(from, buffer, mimeType, prompt, opts);
    await sendMediaResults(from, media);
    if (reply) await sendText(from, reply);
  }
}

function extractDocumentText(buffer, mimeType, filename) {
  const combined = (mimeType + ' ' + filename).toLowerCase();

  if (/\.xlsx|\.xls|spreadsheet|excel/i.test(combined)) {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheets = [];
      for (const name of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        sheets.push(`--- Sheet: ${name} ---\n${csv}`);
      }
      return sheets.join('\n\n').substring(0, 30000);
    } catch (err) {
      console.error('[document] XLSX parse failed:', err.message);
      return null;
    }
  }

  if (/\.csv/i.test(combined)) return buffer.toString('utf8').substring(0, 30000);
  if (/text\/|\.txt$|\.json$|\.xml$|\.html$|\.md$|\.js$|\.ts$|\.py$|\.css$/i.test(combined)) {
    return buffer.toString('utf8').substring(0, 30000);
  }

  if (/\.pdf|pdf/i.test(combined)) return null;

  return null;
}

// ---------- Location messages ----------
async function onLocation(from, msg, opts = {}) {
  const loc = msg.location;
  if (!loc) return;

  const lat = loc.latitude;
  const lng = loc.longitude;
  const name = loc.name || '';
  const address = loc.address || '';
  console.log(`[location] ${maskPhone(from)}`);

  const { saveLocation } = require('./services/database');
  saveLocation(from, { lat, lng, name, address }).catch((err) =>
    console.error('[location] Failed to save:', err.message)
  );

  const prompt = name
    ? `The user shared their location: "${name}" (${address || `${lat},${lng}`}). Their location has been saved. What can you tell me about this place? Is there anything interesting nearby?`
    : `The user shared their location at coordinates ${lat},${lng} (${address || 'no address'}). Their location has been saved. What is at this location? What's nearby?`;

  const { text: reply, media } = await geminiHandleText(from, prompt, opts);
  await sendMediaResults(from, media);
  if (reply) await sendText(from, reply);
}

// ---------- Send generated media (images, music, stickers, videos, documents) ----------
async function sendMediaResults(from, mediaItems) {
  if (!mediaItems?.length) return;
  for (const item of mediaItems) {
    try {
      const media = await uploadMedia(item.path, item.mimeType);
      if (item.type === 'image') {
        await sendImage(from, media);
        console.log(`[media] Image sent to ${maskPhone(from)}`);
      } else if (item.type === 'audio') {
        await sendAudio(from, media);
        console.log(`[media] Music sent to ${maskPhone(from)}`);
      } else if (item.type === 'sticker') {
        await sendSticker(from, media);
        console.log(`[media] Sticker sent to ${maskPhone(from)}`);
      } else if (item.type === 'video') {
        await sendVideo(from, media, item.filename || 'video.mp4');
        console.log(`[media] Video sent to ${maskPhone(from)}`);
      } else if (item.type === 'document') {
        await sendDocument(from, media, item.filename || 'document.pdf', '');
        console.log(`[media] Document sent to ${maskPhone(from)}`);
      }
    } catch (err) {
      console.error(`[media] Failed to send ${item.type}:`, err.message);
    } finally {
      cleanFile(item.path);
    }
  }
}

// ---------- Audio / Voice messages ----------
async function onAudio(from, msg, opts = {}) {
  const mediaId = msg.audio?.id;
  if (!mediaId) return;

  console.log(`[audio] ${maskPhone(from)}`);
  const { buffer, mimeType } = await downloadMedia(mediaId);
  const sessionKey = opts.sessionKey || from;
  const isOwner = opts.isOwner !== undefined ? opts.isOwner : isOwnerNumber(from);
  const userPlan = opts.plan !== undefined && opts.plan !== null
    ? opts.plan
    : (opts.user ? opts.user.plan : null);
  const audioOpts = { isGroup: opts.isGroup || false, isOwner, sessionKey, plan: userPlan };

  let oggPath = null;
  try {
    // Step 1: understand audio + get text reply, Step 2: TTS the reply
    const { textReply, pcmBase64 } = await handleAudioToAudio(from, buffer, mimeType, audioOpts);
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');

    // Step 3: convert PCM to OGG/Opus for WhatsApp
    oggPath = await pcmBufferToOgg(pcmBuffer);

    // Step 4: upload and send voice note
    const media = await uploadMedia(oggPath, 'audio/ogg; codecs=opus');
    await sendAudio(from, media);
    console.log(`[audio] Voice reply sent to ${maskPhone(from)}`);
  } catch (err) {
    console.error('[audio] Voice reply failed, falling back to text:', err.message);
    try {
      const textReply = await handleAudioToText(from, buffer, mimeType, audioOpts);
      await sendText(from, textReply);
    } catch (fallbackErr) {
      console.error('[audio] Text fallback also failed:', fallbackErr.message);
      await sendText(
        from,
        'I had trouble processing your voice note. Try again?\nלא הצלחתי לעבד את ההודעה הקולית. נסה שוב?'
      ).catch(() => {});
    }
  } finally {
    if (oggPath) cleanFile(oggPath);
  }
}

// ---------- Admin notifications ----------
const ADMIN_PHONE = process.env.ADMIN_PHONE || '972527305577';

async function migrateOAuthTokensFromLIDs() {
  try {
    const db = require('./services/database').getDb();
    const usersSnap = await db.collection('users').listDocuments();
    for (const docRef of usersSnap) {
      const userId = docRef.id;
      if (!userId.includes('@') && !userId.includes('lid')) continue;

      const pnUser = await getPNForLID(userId.includes('@') ? userId : `${userId}@lid`);
      if (!pnUser) continue;

      const tokenSnap = await db.collection('users').doc(userId)
        .collection('meta').doc('google_tokens').get();
      if (!tokenSnap.exists) continue;

      const tokens = tokenSnap.data();
      console.log('[oauth-migrate] Migrating tokens to phone-based key');

      await db.collection('users').doc(pnUser)
        .collection('meta').doc('google_tokens')
        .set(tokens, { merge: true });

      const { getOAuth2ClientAsync } = require('./services/google-auth');
      const client = await getOAuth2ClientAsync(pnUser);
      if (client) {
        client.setCredentials(tokens);
        console.log(`[oauth-migrate] Tokens loaded for ${pnUser}`);
      }
    }
  } catch (err) {
    console.error('[oauth-migrate] Error:', err.message);
  }
}

function notifyAdmin(message) {
  sendText(ADMIN_PHONE, message).catch((err) =>
    console.error('[notify] Failed to notify admin:', err.message)
  );
}

// ---------- Onboarding for new users ----------
const billingEnabled = !!process.env.STRIPE_SECRET_KEY;

async function handleOnboarding(from, msg) {
  const text = msg.text?.body?.trim() || '';
  const lowerText = text.toLowerCase();
  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';

  const existingUser = await getAnyUser(from);

  // --- Free trial mode (no payment provider configured) ---
  if (!billingEnabled) {
    if (existingUser && existingUser.status === 'active') {
      await routeMessage(from, msg, existingUser);
      return;
    }

    if (existingUser && existingUser.onboardingStep === 'google_oauth') {
      const link = signedOAuthUrl(from);
      await sendText(from, `כדי לפתוח גישה ל-Gmail, יומן ו-Google Drive, חברו את חשבון Google שלכם:\n${link}\n\nאו פשוט תתחילו לדבר איתי — אפשר לחבר גם אחר כך.`);
      await updateOnboardingStep(from, 'complete');
      await activateUser(from, { plan: 'pro', stripeCustomerId: null, stripeSubscriptionId: null, email: null });
      return;
    }

    await createUser(from, { onboardingStep: 'google_oauth' });
    await activateUser(from, { plan: 'pro', stripeCustomerId: null, stripeSubscriptionId: null, email: null });

    const link = signedOAuthUrl(from);
    const welcome = `👋 *היי! אני Rio* — הסוכן האישי שלך בוואטסאפ.\n\n`;
    const intro = `אני יודע לעזור כמעט בכל דבר: לענות על שאלות, לחפש מידע בזמן אמת, ליצור תמונות ומוזיקה, לנהל את היומן והמיילים שלך, לעקוב אחרי הוצאות, ועוד הרבה.\n\n`;
    const google = `לחוויה המלאה, חברו את חשבון Google שלכם:\n${link}\n\nאו פשוט תתחילו לדבר איתי — אפשר לחבר גם אחר כך!`;
    await sendText(from, welcome + intro + google);

    const displayPhone = formatPhoneForDisplay(from);
    notifyAdmin(`🆕 *לקוח חדש!*\nמספר: ${displayPhone}`);
    return;
  }

  // --- Paid mode (Stripe/PayPlus configured) ---
  if (existingUser && existingUser.status === 'cancelled') {
    const welcome = `היי! נראה שהיה לך חשבון Rio בעבר.\nרוצים לחזור? בחרו מסלול:\n\n`;
    const plans = `*Rio Basic* — 99 ₪/חודש\nצ׳אט AI ללא הגבלה, חיפוש, תמונות, מוזיקה, רשימות, מפות, תזכורות והתראות\n\n*Rio Pro* — 179 ₪/חודש\nהכל + Gmail, יומן, Drive, זיכרון אישי, מעקב הוצאות, שליחת הודעות בשמך\n\nהשיבו *basic* או *pro* כדי להירשם.`;
    await sendText(from, welcome + plans);
    await updateOnboardingStep(from, 'payment');
    return;
  }

  if (existingUser && existingUser.onboardingStep === 'payment') {
    if (lowerText === 'basic' || lowerText === 'pro') {
      try {
        const { url } = await createCheckoutSession(from, lowerText);
        await sendText(from, `בחירה מעולה! השלימו את התשלום כאן:\n${url}\n\nאחרי התשלום, שלחו לי הודעה ונתחיל!`);
      } catch (err) {
        console.error('[onboarding] Checkout failed:', err.message);
        await sendText(from, 'משהו השתבש עם הגדרת התשלום. נסו שוב בבקשה.');
      }
      return;
    }
    await sendText(from, `השיבו *basic* או *pro* כדי לבחור מסלול.\n\n*Basic* — 99 ₪/חודש\n*Pro* — 179 ₪/חודש\n\nאו בקרו באתר ${serviceUrl} למידע נוסף.`);
    return;
  }

  if (existingUser && existingUser.onboardingStep === 'google_oauth') {
    if (existingUser.plan === 'pro') {
      const link = signedOAuthUrl(from);
      await sendText(from, `ברוכים השבים! חברו את חשבון Google שלכם כדי לפתוח גישה ל-Gmail, יומן ו-Drive:\n${link}\n\nאו פשוט תתחילו לדבר איתי — אפשר לחבר גם אחר כך.`);
      await updateOnboardingStep(from, 'complete');
    } else {
      await updateOnboardingStep(from, 'complete');
      await routeMessage(from, msg, { ...existingUser, status: 'active' });
    }
    return;
  }

  await createUser(from, { name: null, onboardingStep: 'payment' });

  const welcome = `👋 *היי! אני Rio* — הסוכן האישי שלך בוואטסאפ.\n\nאני יודע לעזור כמעט בכל דבר: לענות על שאלות, לחפש מידע בזמן אמת, ליצור תמונות ומוזיקה, לנהל יומן ומיילים, לעקוב אחרי הוצאות, ועוד הרבה.\n\n`;
  const plans = `בחרו מסלול כדי להתחיל:\n\n*Rio Basic* — 99 ₪/חודש\n✓ צ׳אט AI ללא הגבלה (טקסט, קול, תמונות)\n✓ חיפוש אינטרנט, יצירת תמונות ומוזיקה\n✓ רשימות, מפות ומיקום\n✓ תזכורות והודעות מתוזמנות (ריו שולח לכם בזמן)\n\n*Rio Pro* — 179 ₪/חודש\n✓ הכל ב-Basic\n✓ Gmail, יומן ו-Google Drive\n✓ זיכרון אישי — אני זוכר אותך!\n✓ מעקב הוצאות וניתוח מסמכים\n✓ שליחת הודעות בשמך\n\nהשיבו *basic* או *pro* כדי להירשם.`;

  await sendText(from, welcome + plans);

  const displayPhone2 = formatPhoneForDisplay(from);
  notifyAdmin(`🆕 *לקוח חדש!*\nמספר: ${displayPhone2}`);
}

// ---------- Subscription commands ----------
async function handlePlanCommand(from, user) {
  if (!user) {
    await sendText(from, 'No active plan found.');
    return;
  }

  const planInfo = getUserPlan(user);
  if (!planInfo) {
    await sendText(from, 'No active plan found.');
    return;
  }

  let msg = `*Your Plan: Rio ${planInfo.name}*\n`;

  if (user.isAdmin) {
    msg += `Status: Admin (unlimited)\n`;
  } else {
    msg += `Price: ${planInfo.price} ₪/month\n`;
    msg += `Status: ${user.status}\n`;

    if (user.stripeSubscriptionId) {
      try {
        const sub = await getSubscriptionStatus(user.stripeSubscriptionId);
        if (sub) {
          const renewDate = new Date(sub.currentPeriodEnd).toLocaleDateString('he-IL');
          msg += `Renewal: ${renewDate}\n`;
          if (sub.cancelAtPeriodEnd) msg += `⚠️ Cancels at end of period\n`;
        }
      } catch { /* ignore */ }
    }

    msg += `\n/upgrade — upgrade or change plan\n/billing — manage payment & invoices`;
  }

  await sendText(from, msg);
}

async function handleBillingCommand(from, user, command) {
  if (!user || user.isAdmin) {
    await sendText(from, 'Admin accounts don\'t have billing.');
    return;
  }

  if (!user.stripeCustomerId) {
    await sendText(from, 'No billing information found. Contact support.');
    return;
  }

  try {
    const portalUrl = await createPortalSession(user.stripeCustomerId);
    const action = command === '/upgrade' ? 'upgrade your plan' : 'manage your billing';
    await sendText(from, `Open this link to ${action}:\n${portalUrl}`);
  } catch (err) {
    console.error('[billing] Portal session failed:', err.message);
    await sendText(from, 'Sorry, could not open the billing portal. Please try again.');
  }
}

// ---------- Briefing preferences ----------
async function handleBriefingCommand(from, text) {
  const { getBriefingPrefs, setBriefingEnabled, setBriefingTime, buildBriefing } = require('./services/briefing');

  const arg = text.replace('/briefing', '').trim().toLowerCase();

  if (arg === 'on' || arg === 'כן') {
    await setBriefingEnabled(from, true);
    await sendText(from, 'תדריך בוקר יומי *הופעל*. תקבל אותו כל בוקר ב-07:00.\n\nלשנות שעה: /briefing 08:30\nלבטל: /briefing off');
    return;
  }

  if (arg === 'off' || arg === 'לא') {
    await setBriefingEnabled(from, false);
    await sendText(from, 'תדריך בוקר *בוטל*. לא תקבל יותר תדריכים אוטומטיים.\n\nאתה תמיד יכול לבקש ידנית: "תדריך בוקר"\nלהפעיל מחדש: /briefing on');
    return;
  }

  const timeMatch = arg.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const mins = parseInt(timeMatch[2], 10);
    if (hours >= 0 && hours <= 23 && mins >= 0 && mins <= 59) {
      const formatted = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      await setBriefingTime(from, formatted);
      await sendText(from, `תדריך בוקר *הופעל* ויישלח כל יום ב-*${formatted}*.\n\nלבטל: /briefing off`);
      return;
    }
  }

  if (arg === '' || arg === 'now' || arg === 'עכשיו') {
    const briefing = await buildBriefing(from);
    await sendText(from, briefing);
    return;
  }

  const prefs = await getBriefingPrefs(from);
  const status = prefs?.enabled === true ? `מופעל (${prefs.time || '07:00'})` : prefs?.enabled === false ? 'מבוטל' : 'טרם הוגדר';
  await sendText(from, `*תדריך בוקר — ${status}*\n\n/briefing on — הפעלה\n/briefing off — ביטול\n/briefing 08:30 — בחירת שעה\n/briefing — קבל תדריך עכשיו`);
}

// ---------- Google OAuth (per-user) ----------
const { getAuthUrl, parseOAuthState, handleCallback, isAuthenticated, migrateLegacyTokens } = require('./services/google-auth');
const { getUserName } = require('./services/user-profiles');

// Migrate Or's legacy tokens on startup
migrateLegacyTokens('972527305577');

app.get('/privacy', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rio – Privacy Policy</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#222;line-height:1.7}h1{font-size:1.5em}h2{font-size:1.2em;margin-top:1.5em}</style></head><body>
<h1>מדיניות פרטיות – Rio WhatsApp Assistant</h1>
<p><strong>עדכון אחרון:</strong> אפריל 2026</p>

<h2>מה זה Rio?</h2>
<p>Rio הוא עוזר אישי מבוסס בינה מלאכותית הפועל בוואטסאפ.</p>

<h2>עיבוד הודעות</h2>
<ul>
<li>ההודעות שלך מעובדות על ידי מודלים של בינה מלאכותית לצורך מתן מענה. הספקים כוללים: <strong>Google (Gemini)</strong>, <strong>Anthropic (Claude)</strong>, <strong>OpenAI (ChatGPT)</strong>.</li>
<li>ההודעות נשלחות לספקי ה-AI לצורך עיבוד בלבד ואינן נשמרות אצלם לאורך זמן, בהתאם לתנאי השירות של כל ספק.</li>
<li>היסטוריית השיחה נשמרת מוצפנת (AES-256-GCM) ונמחקת לאחר 4 שעות של חוסר פעילות.</li>
</ul>

<h2>הצפנה ואבטחה</h2>
<ul>
<li>כל המידע האישי (זיכרונות, רשימות, תזכורות, הוצאות, מיקום) מוצפן בהצפנת AES-256-GCM עם מפתח ייחודי לכל משתמש.</li>
<li>אסימוני Google OAuth מוצפנים לפני שמירה.</li>
<li>מנהל המערכת <strong>אינו יכול</strong> לקרוא את ההודעות או המידע האישי שלך.</li>
</ul>

<h2>גישה ל-Google</h2>
<ul>
<li>הגישה ל-Gmail, יומן ו-Google Drive מתבצעת רק עבור בעלי החשבון המאושרים דרך OAuth2.</li>
<li>ניתן לבטל גישה בכל עת דרך <a href="https://myaccount.google.com/permissions">הגדרות חשבון Google</a>.</li>
</ul>

<h2>שיתוף מידע</h2>
<ul>
<li>מידע אישי לא נמכר, לא משותף ולא מועבר לצדדים שלישיים, למעט ספקי ה-AI לצורך עיבוד ההודעות כמתואר למעלה.</li>
</ul>

<p>לשאלות: שלחו הודעה ל-Rio בוואטסאפ.</p>
</body></html>`);
});

app.get('/oauth/start', (req, res) => {
  try {
    const userId = req.query.user;
    const sig = req.query.sig;
    if (!userId) {
      return res.status(400).send('Missing ?user= parameter. Use /oauth/start?user=PHONE_NUMBER');
    }
    const { hmacVerify } = require('./services/crypto');
    if (!sig || !hmacVerify(userId, 'oauth-start', sig)) {
      return res.status(403).send('Invalid or missing signature. This link can only be generated by Rio.');
    }
    const url = getAuthUrl(userId);
    const masked = userId.length > 5 ? userId.slice(0, 3) + '***' + userId.slice(-2) : '***';
    res.redirect(url);
    console.log(`[oauth] Auth flow started for ${masked}`);
  } catch (err) {
    console.error('[oauth] Start error:', err.message);
    res.status(500).send('OAuth setup failed. Please try again.');
  }
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  const userId = parseOAuthState(req.query.state);
  if (!code) return res.status(400).send('Missing authorization code');
  if (!userId) return res.status(400).send('Invalid or tampered state parameter');

  try {
    await handleCallback(code, userId);
    const { updateUser } = require('./services/users');
    await updateUser(userId, { googleConnected: true, onboardingStep: 'complete' }).catch(() => {});
    const rawName = getUserName(userId) || userId;
    const name = String(rawName).replace(/[<>&"']/g, '');
    res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rio — מחובר!</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5;color:#333}div{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px}h1{font-size:1.4em;margin-bottom:8px}p{color:#666;line-height:1.6}</style></head><body><div><h1>✅ מחובר!</h1><p>חשבון Google חובר בהצלחה עבור <strong>${name}</strong>.<br>אפשר לסגור את הטאב הזה ולחזור לוואטסאפ.</p></div></body></html>`);
  } catch (err) {
    console.error('[oauth] Callback error:', err.message);
    res.status(500).send('OAuth connection failed. Please try again.');
  }
});

// ---------- Checkout API (for landing page) ----------
app.get('/api/checkout', async (req, res) => {
  const { plan, phone } = req.query;
  if (!plan || !phone) return res.status(400).json({ error: 'Missing plan or phone' });
  if (plan !== 'basic' && plan !== 'pro') return res.status(400).json({ error: 'Invalid plan' });

  const { normalizeNumber } = require('./middleware/whitelist');
  const normalized = normalizeNumber(phone);
  if (!/^\d{10,15}$/.test(normalized)) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await createUser(normalized, { onboardingStep: 'payment' });
    const { url } = await createCheckoutSession(normalized, plan);
    res.json({ url });
  } catch (err) {
    console.error('[api/checkout] Error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ---------- Rio phone number API ----------
app.get('/api/rio-number', async (_req, res) => {
  const num = await fetchRioPhoneNumber();
  const greeting = encodeURIComponent('היי Rio! אשמח להכיר אותך ולראות מה אתה יודע לעשות 🤖');
  res.json({ number: num || null, link: num ? `https://wa.me/${num}?text=${greeting}` : null });
});

// ---------- Onboarding success/cancel pages ----------
app.get('/onboarding/success', async (_req, res) => {
  const rioNumber = await fetchRioPhoneNumber();
  const waLink = rioNumber ? `https://wa.me/${rioNumber}?text=Hi` : '#';
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rio — !ברוכים הבאים</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5;color:#333}div{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px}h1{font-size:1.5em;margin-bottom:8px}p{color:#666;line-height:1.6}a{display:inline-block;margin-top:20px;padding:12px 32px;background:#25D366;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head><body><div><h1>🎉 ברוכים הבאים ל-Rio!</h1><p>המנוי שלכם פעיל.<br>חזרו לוואטסאפ ותתחילו לדבר איתי!</p><a href="${waLink}">פתחו את וואטסאפ</a></div></body></html>`);
});

app.get('/onboarding/cancel', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rio — בוטל</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5;color:#333}div{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px}h1{font-size:1.3em;margin-bottom:8px}p{color:#666;line-height:1.6}</style></head><body><div><h1>התשלום בוטל</h1><p>אין בעיה! אפשר להירשם בכל עת — פשוט שלחו הודעה ל-Rio בוואטסאפ.</p></div></body></html>`);
});

app.get('/oauth/status', requireAdminToken, async (req, res) => {
  const userId = req.query.user;
  res.json({ user: userId || 'default', authenticated: await isAuthenticated(userId) });
});

// ---------- Reminders: background scheduler + cron endpoint ----------
const { processDueReminders } = require('./services/reminders');
const REMINDER_POLL_MS = 60 * 1000;
let reminderSchedulerStarted = false;

function startReminderScheduler() {
  if (reminderSchedulerStarted) return;
  reminderSchedulerStarted = true;

  const tick = async () => {
    if (getConnectionState() !== 'open') return;
    try {
      const result = await processDueReminders();
      if (result.total > 0) {
        console.log(`[reminders] Sent ${result.processed}/${result.total} due reminder(s)`);
      }
    } catch (err) {
      console.error('[reminders] Scheduler tick failed:', err.message);
    }
  };

  setInterval(tick, REMINDER_POLL_MS);
  setTimeout(tick, 20_000);
  console.log(`[reminders] Background scheduler active (every ${REMINDER_POLL_MS / 1000}s)`);
}

app.get('/cron/reminders', requireAdminToken, async (_req, res) => {
  try {
    const result = await processDueReminders();
    console.log(`[cron] Reminders processed: ${result.processed}/${result.total}`);
    res.json(result);
  } catch (err) {
    console.error('[cron] Reminder processing failed:', err.message);
    res.status(500).json({ error: 'Reminder processing failed' });
  }
});

// ---------- Slack OAuth ----------
app.get('/slack/connect', (req, res) => {
  const userId = req.query.user;
  const sig = req.query.sig;
  if (!userId) return res.status(400).send('Missing user parameter');
  const { hmacVerify } = require('./services/crypto');
  if (!sig || !hmacVerify(userId, 'slack-connect', sig)) {
    return res.status(403).send('Invalid or missing signature. This link can only be generated by Rio.');
  }
  const { isSlackConfigured, getSlackAuthUrl } = require('./services/slack');
  if (!isSlackConfigured()) {
    return res.send('<html><body><h2>Slack integration is not configured yet.</h2><p>The admin needs to add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.</p></body></html>');
  }
  res.redirect(getSlackAuthUrl(userId));
});

app.get('/slack/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  const { handleSlackOAuthCallback, parseSlackOAuthState } = require('./services/slack');
  const userId = parseSlackOAuthState(state);
  if (!userId) return res.status(400).send('Invalid or tampered state parameter');
  try {
    const teamName = await handleSlackOAuthCallback(code, userId);
    const safeName = String(teamName).replace(/[<>&"']/g, '');
    res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>Slack Connected!</h1><p>Workspace: ${safeName}</p><p>Go back to WhatsApp and try: "מה חדש בסלאק?"</p></body></html>`);
  } catch (err) {
    console.error('[slack] OAuth failed:', err.message);
    res.status(500).send('Slack connection failed. Please try again.');
  }
});

// ---------- Analytics dashboard (admin only) ----------
app.get('/admin/analytics', requireAdminToken, async (req, res) => {
  try {
    const { getUsageStats, renderDashboard } = require('./services/analytics');
    const stats = await getUsageStats();
    res.send(renderDashboard(stats));
  } catch (err) {
    console.error('[analytics] Dashboard error:', err.message);
    res.status(500).send('Failed to load analytics');
  }
});

// ---------- Daily briefing cron ----------
app.get('/cron/briefing', requireAdminToken, async (req, res) => {
  try {
    const { getDb } = require('./services/database');
    const { buildBriefing, getBriefingPrefs, setBriefingEnabled } = require('./services/briefing');
    const usersSnap = await getDb().collection('users')
      .where('status', '==', 'active')
      .get();

    let sent = 0;
    let skipped = 0;
    for (const doc of usersSnap.docs) {
      const data = doc.data();
      if (data.plan !== 'pro' && data.plan !== 'admin') continue;

      const prefs = await getBriefingPrefs(doc.id);
      if (!prefs) continue;

      if (prefs.enabled === false) {
        skipped++;
        continue;
      }

      try {
        const briefing = await buildBriefing(doc.id);

        if (prefs.enabled === null) {
          await sendText(doc.id, briefing);
          await sendText(doc.id, 'זה התדריך היומי שלך. רוצה לקבל אותו כל בוקר?\n\nשלח *כן* להפעלה, *לא* לביטול, או */briefing 08:30* לבחור שעה.');
          await setBriefingEnabled(doc.id, 'asked');
        } else {
          await sendText(doc.id, briefing);
        }
        sent++;
      } catch (err) {
        console.error('[briefing] Failed for user:', err.message);
      }
    }
    console.log(`[cron] Briefing: sent=${sent}, skipped=${skipped}`);
    res.json({ sent, skipped });
  } catch (err) {
    console.error('[briefing] Cron error:', err.message);
    res.status(500).json({ error: 'Briefing processing failed' });
  }
});

// ---------- Admin: WhatsApp profile management ----------
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/admin/profile/picture', requireAdminToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  try {
    const sharp = require('sharp');
    const imgBuffer = await sharp(req.file.buffer).resize(640, 640, { fit: 'cover' }).png().toBuffer();
    await updateProfilePicture(imgBuffer);
    res.json({ status: 'Profile picture updated' });
  } catch (err) {
    console.error('[admin] Profile picture update failed:', err.message);
    res.status(500).json({ error: 'Profile picture update failed' });
  }
});

app.post('/admin/profile/name', requireAdminToken, express.json(), async (req, res) => {
  try {
    await updateProfileName(req.body.name);
    res.json({ status: 'Name updated' });
  } catch (err) {
    console.error('[admin] Profile name update failed:', err.message);
    res.status(500).json({ error: 'Name update failed' });
  }
});

app.post('/admin/profile/about', requireAdminToken, express.json(), async (req, res) => {
  try {
    await updateProfileAbout(req.body.text);
    res.json({ status: 'About updated' });
  } catch (err) {
    console.error('[admin] Profile about update failed:', err.message);
    res.status(500).json({ error: 'About update failed' });
  }
});

// ---------- Admin: WhatsApp registration (Baileys) ----------
app.get('/admin/request-code', requireAdminToken, async (req, res) => {
  const phone = req.query.phone || process.env.RIO_PHONE_NUMBER;
  if (!phone) return res.status(400).json({ error: 'No phone number configured (RIO_PHONE_NUMBER)' });

  const { getSocket } = require('./services/baileys');
  const sock = getSocket();
  if (!sock) return res.status(503).json({ error: 'Baileys socket not ready' });

  try {
    const method = req.query.method || 'sms';
    await sock.requestRegistrationCode({
      phoneNumber: '+' + phone.replace(/[^0-9]/g, ''),
      phoneNumberCountryCode: '972',
      phoneNumberNationalNumber: phone.replace(/^972/, ''),
      phoneNumberMobileCountryCode: '425',
      method,
    });
    res.json({ status: 'Code requested', method });
  } catch (err) {
    console.error('[admin] Registration code request failed:', err.message);
    res.status(500).json({ error: 'Registration code request failed' });
  }
});

app.get('/admin/verify', requireAdminToken, async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Missing ?code= parameter' });

  const { getSocket } = require('./services/baileys');
  const sock = getSocket();
  if (!sock) return res.status(503).json({ error: 'Baileys socket not ready' });

  try {
    await sock.register(code.replace(/[^0-9]/g, ''));
    res.json({ status: 'Registered successfully!' });
  } catch (err) {
    console.error('[admin] Registration failed:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ---------- Health check ----------

const PRIVACY_HTML = '<!DOCTYPE html>\n<html lang="he" dir="rtl">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Rio Assistant — מדיניות פרטיות</title>\n<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#333;line-height:1.8;direction:rtl}h1{color:#1a73e8;border-bottom:2px solid #1a73e8;padding-bottom:10px}h2{color:#444;margin-top:30px}.highlight{background:#f0f7ff;border-right:4px solid #1a73e8;padding:12px 16px;margin:20px 0;border-radius:4px}</style>\n</head><body>\n<h1>🤖 Rio Assistant — מדיניות פרטיות</h1>\n<p style="color:#888">עדכון אחרון: מאי 2026</p>\n<div class="highlight"><strong>בקצרה:</strong> Rio רואה רק את ההודעות שאתם שולחים לו ישירות. אנחנו לא רואים שיחות WhatsApp אחרות שלכם, לא מוכרים מידע ולא משתפים אותו.</div>\n<h2>מי אנחנו</h2><p>Rio הוא סוכן AI אישי לוואטסאפ. מופעל על ידי Or Maman — <a href="mailto:or.maman@gmail.com">or.maman@gmail.com</a></p>\n<h2>מה נאסף</h2><ul><li><strong>הודעות ל-Rio בלבד</strong> — רק מה ששולחים ישירות ל-Rio</li><li><strong>מספר טלפון</strong> — לזיהוי החשבון</li><li><strong>שם WhatsApp</strong> — לפנייה בשמכם</li><li><strong>Google (אופציונלי)</strong> — Gmail, יומן, Drive — רק אם חיברתם</li></ul>\n<h2>מה לא נאסף</h2><ul><li>❌ שיחות WhatsApp עם אחרים</li><li>❌ תמונות/קבצים שלא שלחתם ל-Rio</li><li>❌ מיקום, אנשי קשר, סיסמאות</li></ul>\n<h2>אבטחה</h2><p>כל הנתונים מוצפנים בתקן AES-256. טוקני Google מוצפנים ב-Firestore.</p>\n<h2>מחיקת חשבון</h2><p>שלחו ל-Rio: <strong>"מחק את החשבון שלי"</strong> או: <a href="mailto:or.maman@gmail.com">or.maman@gmail.com</a></p>\n<h2>ביטול גישת Google</h2><p><a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> ← חפשו Rio Assistant</p>\n</body></html>';

// Privacy Policy
app.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PRIVACY_HTML);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), whatsapp: getConnectionState() });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
const SERVICE_URL = process.env.SERVICE_URL
  || (process.env.K_SERVICE && process.env.GOOGLE_CLOUD_PROJECT
    ? `https://${process.env.K_SERVICE}-${process.env.GOOGLE_CLOUD_PROJECT}.me-west1.run.app`
    : `http://localhost:${PORT}`);
app.listen(PORT, async () => {
  console.log(`Rio is live → ${SERVICE_URL}`);

  try {
    await initBaileys(handleBaileysMessage);
    console.log('[startup] Baileys initialized');
    startReminderScheduler();
  } catch (err) {
    console.error('[startup] Baileys init failed:', err.message);
  }

  migrateOAuthTokensFromLIDs().catch(err => console.error('[startup] OAuth migration failed:', err.message));

  const adminPhones = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);
  for (const p of adminPhones) {
    isAuthenticated(p.trim()).then(a => console.log(`[startup] Admin Google auth: ${a}`));
  }
});

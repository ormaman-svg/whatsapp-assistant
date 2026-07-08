'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { addToHistory, getHistory } = require('./session');
const { getFilteredDeclarations, executeTool } = require('./tools');
const { getSystemInstruction } = require('./system-prompt');
const { isAllowed } = require('../middleware/whitelist');

const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOOL_ROUNDS = 5;

const CALENDAR_INTENT = /יומן|calendar|פגישה|meeting|אירוע|event|תור|appointment|לוז|schedule|קבע|תקבע|תזמן|תוסיף ליומן|בטל|ביטול|מחק|הסר|cancel/i;
const CALENDAR_CANCEL_INTENT = /בטל|ביטול|מחק|הסר|cancel|delete|remove/i;
const CALENDAR_ACTION_TOOLS = new Set([
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'list_calendar_events',
]);

/**
 * Convert any value to a protobuf-Struct-safe object.
 * Gemini's functionResponse.response MUST be a plain object with only
 * string/number/boolean/null values, arrays, or nested objects.
 */
function toSafeStruct(value) {
  try {
    const cleaned = JSON.parse(JSON.stringify(value));
    if (Array.isArray(cleaned)) return { results: cleaned };
    if (typeof cleaned === 'object' && cleaned !== null) return cleaned;
    return { value: cleaned };
  } catch {
    return { value: String(value) };
  }
}

/**
 * Retry a Gemini SDK call on transient errors (503, 429).
 */
async function sendWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = /503|429|high demand|overloaded|rate limit|fetch failed|ECONNRESET/i.test(err.message);
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = (attempt + 1) * 2500;
      console.log(`[gemini] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Gemini SDK's response.text() throws GoogleGenerativeAIResponseError when the
 * candidate is blocked (safety, recitation, etc.) or text is unavailable — that
 * used to bubble to routeMessage as a generic "something went wrong".
 */
function extractReplyText(response) {
  try {
    let txt = response.text();
    // Strip THOUGHT blocks (internal reasoning leaked into output)
    txt = txt.replace(/<thinking>[\s\S]*?<\/antml:thinking>/gi, '').trim();
    txt = txt.replace(/^THOUGHT[:\s][\s\S]*?(?=\n\S|$)/m, '').trim();
    return txt;
  } catch (err) {
    const name = err?.constructor?.name || '';
    const isResponseErr = name === 'GoogleGenerativeAIResponseError' || /response.*blocked|text not available/i.test(err.message || '');
    if (!isResponseErr) throw err;
    console.error('[gemini] extractReplyText:', err.message);
    const hint =
      'The model could not return a normal reply (blocked or empty). Try rephrasing.\n' +
      'המודל לא החזיר תשובה רגילה (חסימה או תשובה ריקה). נסה לנסח אחרת.';
    const detail = (err.message || '').replace(/\s+/g, ' ').trim();
    return detail && detail.length < 400 ? `${hint}\n\n(${detail})` : hint;
  }
}

let genai = null;

function getGenAI() {
  if (!genai) {
    genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genai;
}

function getTools(isOwner = true, plan = 'admin', messageText = '') {
  const decls = getFilteredDeclarations(isOwner, plan, messageText);
  if (decls.length === 0) return undefined;
  return [{ functionDeclarations: decls }];
}

async function getModel(userId, opts = {}) {
  const isOwner = opts.isOwner !== undefined ? opts.isOwner : isAllowed(userId);
  const plan = opts.plan || 'admin';
  const messageText = opts.messageText || '';
  const sysInstruction = await getSystemInstruction(userId, opts);
  const tools = getTools(isOwner, plan, messageText);
  const config = {
    model: 'gemini-2.5-flash',
    systemInstruction: sysInstruction,
  };
  if (tools) config.tools = tools;
  return getGenAI().getGenerativeModel(config);
}

const MAX_CHAT_TURNS = 10;

function buildChatHistory(userId) {
  const all = getHistory(userId)
    .filter((entry) => entry.parts.some((p) => p.text !== undefined))
    .map((entry) => ({
      role: entry.role,
      parts: entry.parts.filter((p) => p.text !== undefined),
    }));
  const sliced = all.slice(-MAX_CHAT_TURNS * 2);
  // Gemini requires history to start with 'user' role
  const firstUserIdx = sliced.findIndex(e => e.role === 'user');
  return firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced;
}

/**
 * Core chat loop that handles function calling.
 * Sends a message, checks if Gemini wants to call tools, executes them,
 * feeds results back, and repeats until Gemini returns a text response.
 */
async function chatWithTools(chat, inputParts, userId, opts = {}) {
  const mediaQueue = [];
  const toolsCalled = new Set();
  const userText = typeof inputParts === 'string' ? inputParts : '';
  let result = await sendWithRetry(() => chat.sendMessage(inputParts));
  let response = result.response;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const functionCalls = parts.filter((p) => p.functionCall);
    if (functionCalls.length === 0) break;

    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      toolsCalled.add(name);
      let toolResult;
      try {
        toolResult = await executeTool(name, args || {}, userId, { plan: opts.plan });
      } catch (err) {
        console.error(`[tools] Error in ${name}:`, err.message);
        toolResult = { error: err.message };
      }
      // Collect media results for the handler to send separately
      if (toolResult?._media) {
        mediaQueue.push(toolResult._media);
        const { _media, ...rest } = toolResult;
        toolResult = rest;
      }
      // Serialize to plain JSON to avoid protobuf Struct issues with nested/complex types
      const safeResult = toSafeStruct(toolResult);

      functionResponses.push({
        functionResponse: {
          name,
          response: safeResult,
        },
      });
    }

    result = await sendWithRetry(() => chat.sendMessage(functionResponses));
    response = result.response;
  }

  // Model often replies "קבעתי פגישה" without calling create_calendar_event — force one retry
  const wantsCalendarAction = CALENDAR_INTENT.test(userText);
  const wantsCancel = CALENDAR_CANCEL_INTENT.test(userText);
  const usedCalendarTool = [...toolsCalled].some((t) => CALENDAR_ACTION_TOOLS.has(t));
  if (wantsCalendarAction && !usedCalendarTool) {
    console.warn('[gemini] Calendar intent but no calendar tool called — nudging model');
    const nudge = wantsCancel
      ? '[System] The user asked to cancel/delete a meeting. Call list_calendar_events if needed, then delete_calendar_event with search (title) or event_id. Do not say it was cancelled until the tool returns status cancelled.'
      : '[System] The user asked to schedule or check calendar. You MUST call create_calendar_event or list_calendar_events now with real ISO times. Do not reply that the meeting exists until the tool returns success.';
    result = await sendWithRetry(() => chat.sendMessage(nudge));
    response = result.response;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const parts = response.candidates?.[0]?.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);
      if (functionCalls.length === 0) break;
      const functionResponses = [];
      for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        toolsCalled.add(name);
        let toolResult;
        try {
          toolResult = await executeTool(name, args || {}, userId, { plan: opts.plan });
        } catch (err) {
          console.error(`[tools] Error in ${name}:`, err.message);
          toolResult = { error: err.message };
        }
        if (toolResult?._media) {
          mediaQueue.push(toolResult._media);
          const { _media, ...rest } = toolResult;
          toolResult = rest;
        }
        functionResponses.push({
          functionResponse: { name, response: toSafeStruct(toolResult) },
        });
      }
      result = await sendWithRetry(() => chat.sendMessage(functionResponses));
      response = result.response;
    }
  }

  let finalText = extractReplyText(response);
  // Strip internal THOUGHT blocks from user-facing output
  finalText = finalText.replace(/^THOUGHT[\s\S]*?\n(?=\S)/m, '').trim();
  return { text: finalText, media: mediaQueue, toolsCalled };
}

async function handleText(userId, text, opts = {}) {
  const t0 = Date.now();
  const sessionKey = opts.sessionKey || userId;
  const history = buildChatHistory(sessionKey);
  const t_hist = Date.now();
  const modelOpts = { ...opts, messageText: text };
  const model = await getModel(userId, modelOpts);
  const t1 = Date.now();
  const chat = model.startChat({ history });

  const plan = opts.plan || 'admin';
  addToHistory(sessionKey, 'user', [{ text }]);
  const { text: reply, media } = await chatWithTools(chat, text, userId, { plan });
  const t2 = Date.now();
  addToHistory(sessionKey, 'model', [{ text: reply }]);

  const isOwner = opts.isOwner !== undefined ? opts.isOwner : isAllowed(userId);
  const toolCount = getFilteredDeclarations(isOwner, plan, text).length;
  console.log(`[perf] tools=${toolCount} hist=${t_hist - t0}ms setup=${t1 - t_hist}ms gemini=${t2 - t1}ms total=${t2 - t0}ms`);
  return { text: reply, media };
}

async function handleImage(userId, imageBuffer, mimeType, caption, opts = {}) {
  const sessionKey = opts.sessionKey || userId;
  const history = buildChatHistory(sessionKey);
  const modelOpts = { ...opts, messageText: caption || '' };
  const model = await getModel(userId, modelOpts);
  const chat = model.startChat({ history });

  const prompt = caption || 'What do you see in this image? Describe it helpfully.';
  const parts = [
    {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    },
    { text: prompt },
  ];

  const plan = opts.plan || 'admin';
  addToHistory(sessionKey, 'user', [{ text: `[Image] ${prompt}` }]);
  const { text: reply, media } = await chatWithTools(chat, parts, userId, { plan });
  addToHistory(sessionKey, 'model', [{ text: reply }]);
  return { text: reply, media };
}

function isVoiceCapabilityDenial(text) {
  if (!text) return false;
  const patterns = [
    /לא (יכול|מסוגל|יודע).{0,40}(להאזין|לשמוע|קול|הודעות קול|voice)/i,
    /אינני (יכול|מסוגל).{0,40}(להאזין|לשמוע|קול)/i,
    /אני לא (יכול|מסוגל).{0,40}(להאזין|לשמוע|קול|voice)/i,
    /cannot (listen|hear).{0,30}(voice|audio)/i,
    /can't (listen|hear).{0,30}(voice|audio)/i,
    /do not support.{0,30}(voice|audio)/i,
    /text.?only|only text/i,
    /מודל שפה.{0,30}(טקסט|text)/i,
  ];
  return patterns.some((p) => p.test(text));
}

async function handleAudioToText(userId, audioBuffer, mimeType, opts = {}) {
  const sessionKey = opts.sessionKey || userId;
  const history = buildChatHistory(sessionKey);
  const voiceOpts = { ...opts, isVoiceMessage: true, messageText: '[Voice message]' };
  const model = await getModel(userId, voiceOpts);
  const chat = model.startChat({ history });

  const promptText = opts.isForwarded
    ? 'This is a WhatsApp voice message the user FORWARDED to you (someone else recorded it) — they want a quick summary, not a conversation. You CAN hear it — listen carefully (Hebrew or English) and reply with a short summary: 2-4 bullet points covering who is talking about what, and any dates/numbers/action items mentioned. Do NOT say you cannot listen to voice messages.'
    : 'This is a WhatsApp voice message from the user. You CAN hear it — listen carefully, understand the content (Hebrew or English), and respond helpfully to what they said. Do NOT say you cannot listen to voice messages.';

  const parts = [
    {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType || 'audio/ogg; codecs=opus',
      },
    },
    { text: promptText },
  ];

  const plan = opts.plan || 'admin';
  addToHistory(sessionKey, 'user', [{ text: opts.isForwarded ? '[Forwarded voice message]' : '[Voice message]' }]);
  let { text: reply } = await chatWithTools(chat, parts, userId, { plan });

  if (isVoiceCapabilityDenial(reply)) {
    console.warn('[audio] Model denied voice capability — retrying with strict instruction');
    const retry = await sendWithRetry(() =>
      chat.sendMessage(
        'You already received the voice audio above. Transcribe what the user said and answer their request. You MUST NOT claim you cannot hear or process voice messages.'
      )
    );
    reply = extractReplyText(retry.response);
  }

  addToHistory(sessionKey, 'model', [{ text: reply }]);
  return reply;
}

async function handleAudioToAudio(userId, audioBuffer, mimeType, opts = {}) {
  const textReply = await handleAudioToText(userId, audioBuffer, mimeType, opts);
  const pcmBase64 = await textToSpeech(textReply);
  return { textReply, pcmBase64 };
}

async function textToSpeech(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `${GEMINI_API_BASE}/models/${TTS_MODEL}:generateContent`;

  const response = await axios.post(
    url,
    {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: 'Orus' },
          },
        },
      },
    },
    { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 60_000 }
  );

  const candidate = response.data.candidates?.[0];
  const audioPart = candidate?.content?.parts?.find(
    (p) => p.inlineData || p.inline_data
  );

  if (!audioPart) throw new Error('TTS model did not return audio');
  return (audioPart.inlineData || audioPart.inline_data).data;
}

module.exports = { handleText, handleImage, handleAudioToText, handleAudioToAudio };

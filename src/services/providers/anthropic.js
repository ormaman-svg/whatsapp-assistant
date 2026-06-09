'use strict';

const axios = require('axios');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 2;

async function withRetry(fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 529 || status === 503 || /overloaded|rate/i.test(err.message);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = (attempt + 1) * 2000;
      console.log(`[anthropic] Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function convertTools(functionDeclarations) {
  return functionDeclarations.map((f) => ({
    name: f.name,
    description: f.description,
    input_schema: f.parameters,
  }));
}

function convertHistory(history) {
  const messages = [];
  for (const entry of history) {
    const role = entry.role === 'model' ? 'assistant' : 'user';
    const textParts = entry.parts.filter((p) => p.text);
    if (textParts.length) {
      messages.push({ role, content: textParts.map((p) => p.text).join('\n') });
    }
  }
  // Claude requires alternating user/assistant — merge consecutive same-role messages
  const merged = [];
  for (const msg of messages) {
    if (merged.length && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

async function chat({ messages, systemInstruction, tools, model }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 4096,
    system: systemInstruction,
    messages,
  };

  if (tools?.length) {
    body.tools = convertTools(tools);
  }

  let response;
  try {
    response = await withRetry(() => axios.post(API_URL, body, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    }));
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 500) : '';
    console.error(`[anthropic] Chat error ${err.response?.status}: ${detail}`);
    throw err;
  }

  return parseResponse(response);
}

async function sendToolResults({ messages, systemInstruction, tools, toolResults, model }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const toolResultContent = toolResults.map((tr) => ({
    type: 'tool_result',
    tool_use_id: tr.id,
    content: JSON.stringify(tr.result),
  }));

  const updatedMessages = [
    ...messages,
    { role: 'user', content: toolResultContent },
  ];

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 4096,
    system: systemInstruction,
    messages: updatedMessages,
  };

  if (tools?.length) {
    body.tools = convertTools(tools);
  }

  let response;
  try {
    response = await withRetry(() => axios.post(API_URL, body, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    }));
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 500) : '';
    console.error(`[anthropic] Tool results error ${err.response?.status}: ${detail}`);
    throw err;
  }

  return parseResponse(response);
}

function parseResponse(response) {
  const content = response.data.content || [];
  let text = '';
  const toolCalls = [];

  for (const block of content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
  }

  return { text, toolCalls };
}

module.exports = { chat, sendToolResults, convertHistory, name: 'anthropic', displayName: 'Claude (Sonnet)' };

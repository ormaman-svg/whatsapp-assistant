'use strict';

const axios = require('axios');

const API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o';

function convertTools(functionDeclarations) {
  return functionDeclarations.map((f) => ({
    type: 'function',
    function: {
      name: f.name,
      description: f.description,
      parameters: f.parameters,
    },
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
  return messages;
}

/**
 * Send a chat request to OpenAI with function calling support.
 * Returns { text, toolCalls } where toolCalls is an array of { name, args, id }.
 */
async function chat({ messages, systemInstruction, tools, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      ...messages,
    ],
    max_tokens: 4096,
  };

  if (tools?.length) {
    body.tools = convertTools(tools);
    body.tool_choice = 'auto';
  }

  const response = await axios.post(API_URL, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120_000,
  });

  const choice = response.data.choices?.[0];
  const msg = choice?.message;

  const toolCalls = (msg?.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments || '{}'),
  }));

  return { text: msg?.content || '', toolCalls };
}

/**
 * Send tool results back and get the final response.
 */
async function sendToolResults({ messages, systemInstruction, tools, toolResults, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const toolMessages = toolResults.map((tr) => ({
    role: 'tool',
    tool_call_id: tr.id,
    content: JSON.stringify(tr.result),
  }));

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      ...messages,
      ...toolMessages,
    ],
    max_tokens: 4096,
  };

  if (tools?.length) {
    body.tools = convertTools(tools);
    body.tool_choice = 'auto';
  }

  const response = await axios.post(API_URL, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120_000,
  });

  const choice = response.data.choices?.[0];
  const msg = choice?.message;

  const toolCalls = (msg?.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments || '{}'),
  }));

  return { text: msg?.content || '', toolCalls };
}

module.exports = { chat, sendToolResults, convertHistory, name: 'openai', displayName: 'ChatGPT (GPT-4o)' };

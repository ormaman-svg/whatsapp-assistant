'use strict';

const openai = require('./providers/openai');
const anthropic = require('./providers/anthropic');
const xai = require('./providers/xai');
const { getFilteredDeclarations, executeTool } = require('./tools');
const { getSystemInstruction } = require('./system-prompt');
const { isAllowed } = require('../middleware/whitelist');

const PROVIDERS = { openai, anthropic, xai };
const MAX_TOOL_ROUNDS = 5;

const userModelPrefs = new Map();

const MODEL_ALIASES = {
  gpt: 'openai',
  chatgpt: 'openai',
  openai: 'openai',
  'gpt-4': 'openai',
  'gpt-4o': 'openai',
  claude: 'anthropic',
  anthropic: 'anthropic',
  sonnet: 'anthropic',
  grok: 'xai',
  xai: 'xai',
  gemini: 'gemini',
  rio: 'gemini',
};

function getProvider(name) {
  return PROVIDERS[name] || null;
}

function isProviderConfigured(name) {
  switch (name) {
    case 'openai': return !!process.env.OPENAI_API_KEY;
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'xai': return !!process.env.XAI_API_KEY;
    case 'gemini': return !!process.env.GEMINI_API_KEY;
    default: return false;
  }
}

/**
 * Parse a user message for model override commands.
 * Default is now 'anthropic' (Claude).
 */
function parseModelCommand(userId, text) {
  const trimmed = text.trim();

  if (trimmed.toLowerCase() === '/models') {
    return { providerName: null, message: null, isCommand: 'list' };
  }

  const switchMatch = trimmed.match(/^\/model\s+(\S+)$/i);
  if (switchMatch) {
    const alias = switchMatch[1].toLowerCase();
    const providerName = MODEL_ALIASES[alias];
    if (!providerName) {
      return { providerName: null, message: null, isCommand: 'unknown_model', modelName: alias };
    }
    userModelPrefs.set(userId, providerName);
    return { providerName, message: null, isCommand: 'switched' };
  }

  const prefixMatch = trimmed.match(/^(gpt|chatgpt|claude|grok|gemini):\s*(.+)$/is);
  if (prefixMatch) {
    const alias = prefixMatch[1].toLowerCase();
    const providerName = MODEL_ALIASES[alias];
    return { providerName, message: prefixMatch[2].trim(), isCommand: false };
  }

  return { providerName: userModelPrefs.get(userId) || 'gemini', message: text, isCommand: false };
}

function getAvailableModels() {
  const models = [
    { name: 'gemini', display: 'Gemini 2.5 Flash ← primary', configured: isProviderConfigured('gemini'), prefix: 'gemini:' },
    { name: 'anthropic', display: 'Claude Sonnet 4', configured: isProviderConfigured('anthropic'), prefix: 'claude:' },
    { name: 'openai', display: 'ChatGPT (GPT-4o)', configured: isProviderConfigured('openai'), prefix: 'gpt:' },
    { name: 'xai', display: 'Grok 3', configured: isProviderConfigured('xai'), prefix: 'grok:' },
  ];
  return models;
}

/**
 * Chat with a provider (Claude, OpenAI, xAI), handling the full tool-calling loop.
 * opts: { isGroup, isOwner, sessionKey }
 */
async function chatWithProvider(providerName, userId, userMessage, history, opts = {}) {
  const t0 = Date.now();
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);

  const isOwner = opts.isOwner !== undefined ? opts.isOwner : isAllowed(userId);
  const plan = opts.plan || 'admin';
  const systemInstruction = await getSystemInstruction(userId, { isGroup: opts.isGroup, isOwner });
  const tools = getFilteredDeclarations(isOwner, plan, userMessage);
  const t1 = Date.now();
  const recentHistory = history.slice(-20);
  const convertedHistory = provider.convertHistory(recentHistory);

  const messages = [
    ...convertedHistory,
    { role: 'user', content: userMessage },
  ];

  const mediaQueue = [];
  let response = await provider.chat({ messages, systemInstruction, tools, model: null });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (!response.toolCalls?.length) break;

    const toolResults = [];
    for (const tc of response.toolCalls) {
      let result;
      try {
        result = await executeTool(tc.name, tc.args, userId);
      } catch (err) {
        console.error(`[tools] Error in ${tc.name}:`, err.message);
        result = { error: err.message };
      }

      if (result?._media) {
        mediaQueue.push(result._media);
        const { _media, ...rest } = result;
        result = rest;
      }

      toolResults.push({ id: tc.id, result });
    }

    if (providerName === 'openai' || providerName === 'xai') {
      messages.push({
        role: 'assistant',
        content: response.text || null,
        tool_calls: response.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      });
    } else if (providerName === 'anthropic') {
      messages.push({
        role: 'assistant',
        content: [
          ...(response.text ? [{ type: 'text', text: response.text }] : []),
          ...response.toolCalls.map((t) => ({
            type: 'tool_use',
            id: t.id,
            name: t.name,
            input: t.args,
          })),
        ],
      });
    }

    response = await provider.sendToolResults({
      messages,
      systemInstruction,
      tools,
      toolResults,
      model: null,
    });
  }

  const t2 = Date.now();
  console.log(`[perf] provider=${providerName} tools=${tools.length} setup=${t1 - t0}ms api=${t2 - t1}ms total=${t2 - t0}ms`);
  return { text: response.text || '', media: mediaQueue };
}

function getUserModel(userId) {
  return userModelPrefs.get(userId) || 'gemini';
}

module.exports = {
  parseModelCommand,
  chatWithProvider,
  getAvailableModels,
  getUserModel,
  isProviderConfigured,
  MODEL_ALIASES,
};

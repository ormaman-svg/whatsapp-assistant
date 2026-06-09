'use strict';

const axios = require('axios');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SEARCH_MODEL = 'gemini-2.5-flash-lite';
const MAX_RETRIES = 2;

/**
 * Perform a web search query using Gemini with Google Search grounding.
 * Uses gemini-2.0-flash (lighter, faster) to avoid 503s on the main model.
 * Retries on transient errors.
 */
async function webSearch(query) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/models/${SEARCH_MODEL}:generateContent`;
  const now = new Date().toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' });

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Today is ${now}. Answer this query using the latest information from the web. Be concise and factual. Query: ${query}`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        timeout: 30_000,
      });

      const candidate = response.data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text).join('') || '';

      const sources = [];
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      for (const chunk of chunks.slice(0, 5)) {
        if (chunk.web) {
          sources.push({ title: chunk.web.title || '', url: chunk.web.uri || '' });
        }
      }

      console.log(`[web-search] Success on attempt ${attempt + 1}: "${query}" → ${text.length} chars, ${sources.length} sources`);
      return { answer: text, sources };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const isRetryable = status === 503 || status === 429 || /overloaded|high demand/i.test(err.message);
      if (!isRetryable || attempt === MAX_RETRIES) break;
      const delay = (attempt + 1) * 1500;
      console.log(`[web-search] Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms (${status})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.error(`[web-search] Failed after ${MAX_RETRIES + 1} attempts:`, lastError.message);
  throw lastError;
}

module.exports = { webSearch };

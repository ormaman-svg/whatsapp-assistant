'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');
const LYRIA_CLIP_MODEL = 'lyria-3-clip-preview';
const LYRIA_PRO_MODEL = 'lyria-3-pro-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * Generate music using Lyria 3 via the Gemini API.
 * Supports full songs with vocals/lyrics in any language.
 *
 * @param {string} prompt - Description of the music to generate
 * @param {boolean} [fullSong=false] - Use Pro model for longer tracks with structure
 * @returns {{ audioPath: string, mimeType: string, lyrics?: string }}
 */
async function generateMusic(prompt, fullSong = false) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const model = fullSong ? LYRIA_PRO_MODEL : LYRIA_CLIP_MODEL;
  const url = `${API_BASE}/${model}:generateContent`;

  const response = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO', 'TEXT'],
      },
    },
    {
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      timeout: 180_000,
    }
  );

  const parts = response.data?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error('Lyria did not return any content');

  let audioData = null;
  let mimeType = 'audio/mpeg';
  let lyrics = null;

  for (const part of parts) {
    if (part.text) {
      lyrics = (lyrics || '') + part.text;
    } else if (part.inlineData) {
      audioData = Buffer.from(part.inlineData.data, 'base64');
      mimeType = part.inlineData.mimeType || 'audio/mpeg';
    }
  }

  if (!audioData) throw new Error('Lyria did not return audio data');

  ensureTmpDir();
  const ext = mimeType.includes('wav') ? 'wav' : 'mp3';
  const audioPath = path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(audioPath, audioData);

  console.log(`[music] Generated ${fullSong ? 'full song' : 'clip'} → ${audioPath} (${mimeType})`);
  return { audioPath, mimeType, lyrics };
}

module.exports = { generateMusic };

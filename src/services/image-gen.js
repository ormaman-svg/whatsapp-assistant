'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * Generate an image from a text prompt using Gemini's native image generation.
 * Retries once on failure.
 * Returns { imagePath, mimeType, textResponse }
 */
async function generateImage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/models/${IMAGE_MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        timeout: 120_000,
      });

      const candidate = response.data.candidates?.[0];
      if (!candidate) {
        const feedback = response.data.promptFeedback;
        console.error('[image-gen] No candidates. promptFeedback:', JSON.stringify(feedback));
        throw new Error(feedback?.blockReason
          ? `Prompt blocked: ${feedback.blockReason}`
          : 'Image model returned no candidates');
      }

      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        console.error(`[image-gen] Unexpected finishReason: ${candidate.finishReason}`);
      }

      const parts = candidate.content?.parts || [];
      let textResponse = '';
      let imageData = null;
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          textResponse += part.text;
        } else if (part.inlineData) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
        }
      }

      if (!imageData) {
        console.error(`[image-gen] No image in response. Parts: ${parts.map(p => p.text ? 'text' : 'other').join(', ')}. Text: ${textResponse.substring(0, 200)}`);
        throw new Error('Image model did not return an image');
      }

      ensureTmpDir();
      const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
      const imagePath = path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);
      fs.writeFileSync(imagePath, Buffer.from(imageData, 'base64'));

      console.log(`[image-gen] Generated image → ${imagePath} (${mimeType}, ${imageData.length} chars b64)`);
      return { imagePath, mimeType, textResponse };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const data = err.response?.data;
      console.error(`[image-gen] Attempt ${attempt + 1} failed: ${err.message}`, status, JSON.stringify(data)?.substring(0, 300));
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastError;
}

/**
 * Edit an image based on an input image + text instruction.
 */
async function editImage(imageBuffer, inputMimeType, instruction) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${GEMINI_API_BASE}/models/${IMAGE_MODEL}:generateContent`;

  const response = await axios.post(
    url,
    {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: inputMimeType, data: imageBuffer.toString('base64') } },
            { text: instruction },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    },
    { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 120_000 }
  );

  const parts = response.data.candidates?.[0]?.content?.parts || [];
  let textResponse = '';
  let imageData = null;
  let mimeType = 'image/png';

  for (const part of parts) {
    if (part.text) textResponse += part.text;
    else if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType || 'image/png';
    }
  }

  if (!imageData) throw new Error('Image model did not return an edited image');

  ensureTmpDir();
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
  const imagePath = path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(imagePath, Buffer.from(imageData, 'base64'));

  return { imagePath, mimeType, textResponse };
}

module.exports = { generateImage, editImage };

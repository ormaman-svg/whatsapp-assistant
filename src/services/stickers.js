'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'rio-stickers');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function imageToSticker(buffer) {
  ensureTmp();
  const outPath = path.join(TMP_DIR, `sticker_${Date.now()}.webp`);

  await sharp(buffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toFile(outPath);

  return outPath;
}

async function textToSticker(text) {
  ensureTmp();
  const outPath = path.join(TMP_DIR, `sticker_${Date.now()}.webp`);

  const fontSize = text.length > 20 ? 48 : text.length > 10 ? 64 : 80;
  const lines = wrapText(text, 20);
  const svgText = lines
    .map((line, i) => `<text x="256" y="${256 - (lines.length - 1) * (fontSize * 0.6) + i * fontSize * 1.2}" font-size="${fontSize}" font-family="Arial, sans-serif" font-weight="bold" fill="white" stroke="black" stroke-width="3" text-anchor="middle" dominant-baseline="central">${escapeXml(line)}</text>`)
    .join('\n');

  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="transparent"/>
  ${svgText}
</svg>`;

  await sharp(Buffer.from(svg))
    .webp({ quality: 80 })
    .toFile(outPath);

  return outPath;
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { imageToSticker, textToSticker };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function tmpFile(ext) {
  ensureTmpDir();
  return path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);
}

function cleanFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* best-effort */
  }
}

/**
 * Converts raw PCM (signed 16-bit LE, mono, 24 kHz) from Gemini
 * into an OGG/Opus file that WhatsApp accepts.
 */
function pcmBufferToOgg(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const pcmPath = tmpFile('pcm');
    const oggPath = tmpFile('ogg');

    fs.writeFileSync(pcmPath, pcmBuffer);

    ffmpeg()
      .input(pcmPath)
      .inputFormat('s16le')
      .inputOptions(['-ar 24000', '-ac 1'])
      .audioCodec('libopus')
      .audioFrequency(48000)
      .audioBitrate('64k')
      .audioChannels(1)
      .outputFormat('ogg')
      .on('error', (err) => {
        cleanFile(pcmPath);
        cleanFile(oggPath);
        reject(new Error(`FFmpeg conversion failed: ${err.message}`));
      })
      .on('end', () => {
        cleanFile(pcmPath);
        resolve(oggPath);
      })
      .save(oggPath);
  });
}

module.exports = { pcmBufferToOgg, cleanFile };

'use strict';

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'rio-qr');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function generateQR(text, opts = {}) {
  ensureTmp();
  const outPath = path.join(TMP_DIR, `qr_${Date.now()}.png`);

  await QRCode.toFile(outPath, text, {
    width: opts.width || 512,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });

  return outPath;
}

module.exports = { generateQR };

'use strict';

const fs = require('fs');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getSocket } = require('../services/baileys');

function toJid(phoneOrJid) {
  if (!phoneOrJid) return '';
  if (String(phoneOrJid).includes('@')) return phoneOrJid;
  return `${phoneOrJid}@s.whatsapp.net`;
}

function fromJid(jid) {
  if (!jid) return '';
  return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
}

function maskedJid(jid) {
  const num = fromJid(jid);
  if (!num || num.length < 6) return '***';
  return num.slice(0, 3) + '***' + num.slice(-3);
}

function normalizePhoneNumber(phone) {
  let n = String(phone).replace(/^\+/, '').replace(/[\s\-()]/g, '');
  if (n.startsWith('0') && n.length === 10) {
    n = '972' + n.substring(1);
  }
  return n;
}

function formatPhoneForDisplay(phone) {
  const n = String(phone).replace(/^\+/, '').replace(/[\s\-()]/g, '');
  if (n.startsWith('972') && n.length === 12) {
    const local = '0' + n.substring(3);
    return local.substring(0, 3) + '-' + local.substring(3);
  }
  return '+' + n;
}

async function sendText(to, body) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending text to ${maskedJid(jid)} len=${body.length}`);
  await sock.sendMessage(jid, { text: body });
}

async function markRead(msgKey) {
  const sock = getSocket();
  if (!sock) return;
  try {
    await sock.readMessages([msgKey]);
  } catch { /* ignore */ }
}

async function downloadMedia(baileysMsg) {
  const buffer = await downloadMediaMessage(baileysMsg, 'buffer', {});
  const msg = baileysMsg.message;
  const mimeType =
    msg?.imageMessage?.mimetype ||
    msg?.audioMessage?.mimetype ||
    msg?.documentMessage?.mimetype ||
    msg?.videoMessage?.mimetype ||
    msg?.stickerMessage?.mimetype ||
    'application/octet-stream';
  return { buffer: Buffer.from(buffer), mimeType };
}

async function uploadMedia(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  return { buffer, mimeType };
}

async function sendAudio(to, media) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending audio to ${maskedJid(jid)}`);
  await sock.sendMessage(jid, {
    audio: media.buffer,
    ptt: true,
    mimetype: 'audio/ogg; codecs=opus',
  });
}

async function sendImage(to, media, caption) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending image to ${maskedJid(jid)}`);
  await sock.sendMessage(jid, {
    image: media.buffer,
    caption: caption || '',
    mimetype: media.mimeType || 'image/png',
  });
}

async function sendSticker(to, media) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending sticker to ${maskedJid(jid)}`);
  await sock.sendMessage(jid, { sticker: media.buffer });
}

async function sendDocument(to, media, filename, caption) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending document to ${maskedJid(jid)}: ${filename}`);
  await sock.sendMessage(jid, {
    document: media.buffer,
    fileName: filename || 'file',
    caption: caption || '',
    mimetype: media.mimeType || 'application/octet-stream',
  });
}

async function sendVideo(to, media, filename) {
  const sock = getSocket();
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = toJid(to);
  console.log(`[whatsapp] Sending video to ${maskedJid(jid)}`);
  await sock.sendMessage(jid, {
    video: media.buffer,
    fileName: filename || 'video.mp4',
    mimetype: media.mimeType || 'video/mp4',
  });
}

async function sendMessageToNumber(phoneNumber, text) {
  const normalized = normalizePhoneNumber(phoneNumber);
  return sendText(normalized, text);
}

async function sendGroupMessage(groupId, text) {
  return sendText(groupId, text);
}

async function sendGroupImage(groupId, media, caption) {
  return sendImage(groupId, media, caption);
}

async function sendGroupAudio(groupId, media) {
  return sendAudio(groupId, media);
}

function fetchRioPhoneNumber() {
  const num = process.env.RIO_PHONE_NUMBER || process.env.RIO_WHATSAPP_NUMBER || '';
  return Promise.resolve(num.replace(/[^0-9]/g, '') || null);
}

module.exports = {
  normalizePhoneNumber,
  formatPhoneForDisplay,
  toJid,
  fromJid,
  sendText,
  markRead,
  downloadMedia,
  uploadMedia,
  sendAudio,
  sendImage,
  sendSticker,
  sendDocument,
  sendVideo,
  sendMessageToNumber,
  sendGroupMessage,
  sendGroupImage,
  sendGroupAudio,
  fetchRioPhoneNumber,
};

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'rio-video');
const MAX_SIZE_MB = 16;

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

const ALLOWED_HOSTS = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|vimeo\.com)\//i;

function isVideoLink(text) {
  return /(?:youtube\.com\/watch|youtu\.be\/|tiktok\.com\/|instagram\.com\/(?:reel|p)\/)/.test(text);
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

function validateVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd)/i.test(host)) return false;
    if (!ALLOWED_HOSTS.test(url)) return false;
    return true;
  } catch {
    return false;
  }
}

async function downloadVideo(url) {
  if (!validateVideoUrl(url)) throw new Error('URL not allowed. Supported: YouTube, TikTok, Instagram, Facebook, Twitter, Vimeo.');
  ensureTmp();
  const outTemplate = path.join(TMP_DIR, `vid_${Date.now()}.%(ext)s`);

  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-o', outTemplate,
      '-f', `best[filesize<${MAX_SIZE_MB}M]/bestvideo[filesize<${MAX_SIZE_MB}M]+bestaudio/best`,
      '--max-filesize', `${MAX_SIZE_MB}M`,
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--socket-timeout', '30',
      '--retries', '2',
    ];

    execFile('yt-dlp', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[video] yt-dlp error:', stderr || err.message);
        return reject(new Error(`Download failed: ${err.message}`));
      }

      const destMatch = (stdout + stderr).match(/Destination:\s*(.+)/);
      const mergeMatch = (stdout + stderr).match(/Merging formats into "(.+)"/);
      const alreadyMatch = (stdout + stderr).match(/\[download\]\s+(.+)\s+has already been downloaded/);
      const filePath = mergeMatch?.[1] || destMatch?.[1] || alreadyMatch?.[1];

      if (!filePath) {
        const files = fs.readdirSync(TMP_DIR)
          .filter((f) => f.startsWith(`vid_`))
          .sort()
          .reverse();
        if (files.length) {
          return resolve(path.join(TMP_DIR, files[0]));
        }
        return reject(new Error('Download completed but file not found'));
      }

      resolve(filePath.trim());
    });
  });
}

async function getVideoInfo(url) {
  if (!validateVideoUrl(url)) throw new Error('URL not allowed. Supported: YouTube, TikTok, Instagram, Facebook, Twitter, Vimeo.');
  return new Promise((resolve, reject) => {
    const args = [url, '--dump-json', '--no-download', '--socket-timeout', '15'];
    execFile('yt-dlp', args, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(`Info failed: ${err.message}`));
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title,
          duration: info.duration,
          uploader: info.uploader || info.channel,
          viewCount: info.view_count,
          description: info.description?.substring(0, 500),
          url: info.webpage_url,
        });
      } catch (e) {
        reject(new Error('Failed to parse video info'));
      }
    });
  });
}

module.exports = { downloadVideo, getVideoInfo, isVideoLink, extractUrl };

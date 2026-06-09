'use strict';

const axios = require('axios');

/**
 * Post to Instagram via Meta Graph API.
 * Requires INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID.
 * The token must have instagram_basic, instagram_content_publish, and pages_read_engagement permissions.
 */
async function postToInstagram({ imageUrl, caption }) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!token || !accountId) {
    return {
      error: 'Instagram is not connected yet.',
      setup: 'To enable Instagram posting, connect your Instagram Business account in Meta Business Suite and add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID to the environment.',
    };
  }

  const containerRes = await axios.post(
    `https://graph.facebook.com/v19.0/${accountId}/media`,
    { image_url: imageUrl, caption, access_token: token }
  );

  const containerId = containerRes.data.id;
  if (!containerId) throw new Error('Failed to create media container');

  await new Promise((r) => setTimeout(r, 5000));

  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${accountId}/media_publish`,
    { creation_id: containerId, access_token: token }
  );

  return {
    status: 'Posted to Instagram!',
    mediaId: publishRes.data.id,
    url: `https://www.instagram.com/p/${publishRes.data.id}/`,
  };
}

function isInstagramConfigured() {
  return !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
}

module.exports = { postToInstagram, isInstagramConfigured };

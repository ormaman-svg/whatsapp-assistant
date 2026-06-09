'use strict';

/**
 * Shopping & Delivery integrations.
 *
 * Shufersal / Wolt / Bit -- none have public consumer APIs.
 * This module provides smart link generation and web-search-based functionality
 * to give users the closest experience possible.
 */

function getShufersal(query) {
  const searchUrl = `https://www.shufersal.co.il/online/he/search/results?q=${encodeURIComponent(query)}`;
  const appDeepLink = `shufersal://search?q=${encodeURIComponent(query)}`;

  return {
    webUrl: searchUrl,
    appLink: appDeepLink,
    message: `I can't order directly from Shufersal, but here's a search link for "${query}":`,
    suggestion: `For actual ordering, open the Shufersal app or website.`,
  };
}

function getWolt(query, location) {
  const city = location || 'tel-aviv';
  const searchUrl = `https://wolt.com/he/isr/${encodeURIComponent(city)}/search?q=${encodeURIComponent(query)}`;

  return {
    webUrl: searchUrl,
    message: `I can't order from Wolt directly, but here's a search for "${query}":`,
    suggestion: 'Open the link to browse and order through Wolt.',
  };
}

function getBitPayLink({ phone, amount, note }) {
  const link = `https://www.bitpay.co.il/app/redirect?phone=${phone || ''}&amount=${amount || ''}&note=${encodeURIComponent(note || '')}`;

  return {
    link,
    message: amount
      ? `To send ${amount} ₪${phone ? ` to ${phone}` : ''}, open this Bit link:`
      : 'Open Bit to make a payment:',
    note: 'Bit requires the app installed on your phone. The link will open the Bit app with pre-filled details.',
  };
}

module.exports = { getShufersal, getWolt, getBitPayLink };

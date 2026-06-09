'use strict';

const { google } = require('googleapis');
const { getOAuth2Client } = require('./google-auth');

function getDrive(userId) {
  const auth = getOAuth2Client(userId);
  return google.drive({ version: 'v3', auth });
}

async function searchDrive(query, userId, maxResults = 10) {
  const drive = getDrive(userId);
  const res = await drive.files.list({
    q: query,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink, owners)',
    orderBy: 'modifiedTime desc',
  });

  return (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size ? `${Math.round(parseInt(f.size) / 1024)} KB` : null,
    link: f.webViewLink,
  }));
}

async function readDriveFile(fileId, userId) {
  const drive = getDrive(userId);

  const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType, size' });
  const mimeType = meta.data.mimeType;
  const name = meta.data.name;

  if (mimeType.includes('google-apps.document')) {
    const exported = await drive.files.export({ fileId, mimeType: 'text/plain' });
    return { name, mimeType: 'text/plain', content: String(exported.data).substring(0, 30000) };
  }

  if (mimeType.includes('google-apps.spreadsheet')) {
    const exported = await drive.files.export({ fileId, mimeType: 'text/csv' });
    return { name, mimeType: 'text/csv', content: String(exported.data).substring(0, 30000) };
  }

  if (mimeType.includes('google-apps.presentation')) {
    const exported = await drive.files.export({ fileId, mimeType: 'text/plain' });
    return { name, mimeType: 'text/plain', content: String(exported.data).substring(0, 30000) };
  }

  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
    const res = await drive.files.get({ fileId, alt: 'media' });
    return { name, mimeType, content: String(res.data).substring(0, 30000) };
  }

  return {
    name,
    mimeType,
    content: null,
    message: `File "${name}" is a ${mimeType} file and cannot be read as text. Use the link to view it.`,
    link: `https://drive.google.com/file/d/${fileId}/view`,
  };
}

async function createDocument(title, content, userId) {
  const docs = google.docs({ version: 'v1', auth: getOAuth2Client(userId) });

  const createRes = await docs.documents.create({ requestBody: { title } });
  const docId = createRes.data.documentId;

  if (content) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      },
    });
  }

  return {
    id: docId,
    title,
    link: `https://docs.google.com/document/d/${docId}/edit`,
    status: 'Document created successfully',
  };
}

module.exports = { searchDrive, readDriveFile, createDocument };

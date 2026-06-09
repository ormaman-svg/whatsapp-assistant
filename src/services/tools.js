'use strict';

const { searchEmails, readEmail, sendEmail, getUnreadCount } = require('./gmail');
const { listEvents, createEvent, deleteEvent, updateEvent, cancelEvent } = require('./calendar');
const { generateImage, editImage } = require('./image-gen');
const { generateMusic } = require('./music-gen');
const { isAuthenticated } = require('./google-auth');
const { remember, recall, forget } = require('./memory');
const { getList, setList, getAllListNames } = require('./database');
const { createReminder, listReminders, removeReminder } = require('./reminders');
const { searchPlaces, getDirections } = require('./maps');
const { trackExpense, listUserExpenses, expenseSummary } = require('./expenses');
const { searchDrive, readDriveFile, createDocument } = require('./drive');
const { getLocation } = require('./database');
const { imageToSticker, textToSticker } = require('./stickers');
const { generateQR } = require('./qr');
const { createInvoice } = require('./invoice');
const { downloadVideo, getVideoInfo, isVideoLink, extractUrl } = require('./video');
const { buildBriefing } = require('./briefing');
const { postToInstagram, isInstagramConfigured } = require('./social');
const { listDevices, controlDevice } = require('./smart-home');
const { getUnreadMessages, getRecentMessages, sendSlackMessage, getSlackToken } = require('./slack');
const { getShufersal, getWolt, getBitPayLink } = require('./shopping');
const { hmacSign } = require('./crypto');

function oauthStartUrl(userId) {
  const serviceUrl = process.env.SERVICE_URL || process.env.SERVICE_URL || 'http://localhost:3000';
  const sig = hmacSign(userId, 'oauth-start');
  return sig ? `${serviceUrl}/oauth/start?user=${userId}&sig=${sig}` : `${serviceUrl}/oauth/start?user=${userId}`;
}

const lastUserImage = new Map();

function storeUserImage(userId, buffer, mimeType) {
  lastUserImage.set(userId, { buffer, mimeType, storedAt: Date.now() });
}

function getUserImage(userId) {
  const img = lastUserImage.get(userId);
  if (!img) return null;
  if (Date.now() - img.storedAt > 30 * 60 * 1000) {
    lastUserImage.delete(userId);
    return null;
  }
  return img;
}
const { webSearch } = require('./web-search');
const { searchContacts } = require('./contacts');
const { sendMessageToNumber, formatPhoneForDisplay } = require('../utils/whatsapp');

const functionDeclarations = [
  {
    name: 'web_search',
    description:
      'Search the web for real-time, current information. Use for ANY question that needs up-to-date data: weather forecasts, stock prices, news, sports scores, currency rates, current events, product info, reviews, travel info, or any factual question where the latest data matters. ALWAYS use this tool when the user asks about something that changes over time.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Be specific. Include location for weather (e.g. "weather Tel Aviv today"). Include stock symbol for stocks (e.g. "TSLA stock price today").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_contact',
    description:
      'Look up a contact by name to find their phone number. Searches Google Contacts and learned WhatsApp contacts. Use this BEFORE send_whatsapp_message when the user refers to someone by name.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name or partial name to search for (e.g. "Sapir", "Mom", "David")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Send a WhatsApp message to a phone number on behalf of the user. The message will be sent FROM Rio\'s number. ALWAYS use lookup_contact first if the user gives a name instead of a number. When sending on behalf of someone, prefix the message with their name (e.g. "Or asked me to tell you: ...").',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Phone number to send to. Accepts any format: local Israeli (0525111226), international (972525111226 or +972525111226).',
        },
        message: {
          type: 'string',
          description: 'The message text to send',
        },
      },
      required: ['phone_number', 'message'],
    },
  },
  {
    name: 'search_emails',
    description:
      'Search the user\'s Gmail. Results are ALWAYS returned newest first — do NOT add any sort operators. Supports Gmail search syntax: from:, to:, subject:, is:unread, after:, before:, label:, has:attachment, category:. For the latest email, just use query "in:inbox" with max_results 1.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query. Do NOT include sort/order keywords. Examples: "in:inbox", "from:boss is:unread", "subject:invoice after:2024/01/01"',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of emails to return (default 5, max 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_email',
    description:
      'Read the full content of a specific email by its ID. Use after search_emails to get details of a specific message.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to read',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send an email on behalf of the user. Use when the user asks to send, reply to, or compose an email.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          description: 'Email body text',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_unread_count',
    description:
      'Get the count of unread emails in the user\'s inbox.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_calendar_events',
    description:
      'List upcoming events from the user\'s Google Calendar. Use when the user asks about their schedule, appointments, meetings, or what\'s coming up.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum number of events to return (default 10)',
        },
        time_min: {
          type: 'string',
          description: 'Start of time range in ISO 8601 format (default: now)',
        },
        time_max: {
          type: 'string',
          description: 'End of time range in ISO 8601 format (e.g. end of day, end of week)',
        },
      },
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Create a new event on the user\'s Google Calendar. REQUIRED for any request to schedule/book/add a meeting or appointment — you must call this tool; never claim a meeting was created without a successful tool response. Use ISO 8601 times in Asia/Jerusalem (+03:00). Default duration 30 minutes if end_time omitted.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title',
        },
        start_time: {
          type: 'string',
          description: 'Event start time in ISO 8601 format (e.g. "2025-03-15T10:00:00")',
        },
        end_time: {
          type: 'string',
          description: 'Event end time in ISO 8601 format (e.g. "2025-03-15T11:00:00")',
        },
        description: {
          type: 'string',
          description: 'Event description (optional)',
        },
        location: {
          type: 'string',
          description: 'Event location (optional)',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee email addresses to invite (optional). They will receive a calendar invitation.',
        },
      },
      required: ['summary', 'start_time', 'end_time'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update/reschedule an existing calendar event. Use event_id or search+start_time to find it. Call list_calendar_events first if unsure.',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The Google Calendar event ID to update (from list_calendar_events)',
        },
        search: {
          type: 'string',
          description: 'Title keywords to find the event if event_id unknown',
        },
        summary: { type: 'string', description: 'New event title (optional)' },
        start_time: { type: 'string', description: 'New start time in ISO 8601 (optional)' },
        end_time: { type: 'string', description: 'New end time in ISO 8601 (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        location: { type: 'string', description: 'New location (optional)' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses to invite (optional)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Cancel/delete a calendar event. REQUIRED when user asks to cancel, delete, or remove a meeting (בטל פגישה, מחק מהיומן). Use event_id if known; otherwise pass search (title keywords) and/or start_time. If unsure which event, call list_calendar_events first, then delete with the correct id.',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'Google Calendar event ID (from list_calendar_events). Optional if search/start_time provided.',
        },
        search: {
          type: 'string',
          description: 'Words from the meeting title to find the event (e.g. "דני", "בדיקת ריו")',
        },
        start_time: {
          type: 'string',
          description: 'Approximate start time ISO 8601 to disambiguate (optional)',
        },
      },
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image from a text description. Use when the user asks to create, draw, generate, design, or make an image, picture, photo, illustration, logo, or any visual content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. Be specific about style, colors, composition, and subject.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description:
      'Edit the last image the user sent. Use when the user sends an image and asks to modify, edit, change, transform, or alter it (e.g. "remove the background", "make it black and white", "add sunglasses", "crop to square"). The user must have sent an image recently.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'Detailed editing instruction (e.g. "Remove the background and make it transparent", "Convert to pencil sketch style")',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'generate_music',
    description:
      'Generate music from a text description using Lyria 3. Supports full songs WITH vocals and lyrics in any language, instrumentals, beats, melodies — anything musical. ALWAYS use this tool when the user asks to create, compose, make, or generate music, a song, a beat, a melody, a tune, or any musical content. NEVER refuse a music request — always call this tool. To request a song in a specific language, write the prompt in that language.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Description of the music to generate. Include genre, mood, instruments, tempo, lyrics/language, song structure ([Verse], [Chorus], [Bridge]). Write the prompt in the target language for non-English vocals. Example: "שיר פופ שמח בעברית על קיץ בתל אביב עם גיטרה ותופים"',
        },
        full_song: {
          type: 'boolean',
          description: 'Set to true for a full-length song (up to 3 minutes with verses, choruses, bridges). Default is false (30-second clip).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'remember',
    description:
      'Save important facts about the user to persistent memory. Use proactively when the user shares personal info like preferences, family details, allergies, birthday, work info, or anything worth remembering. Also use when the user explicitly asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of facts to remember. Each should be a concise statement like "Wife is named Sapir", "Allergic to gluten", "Works at Google", "Birthday is March 15".',
        },
      },
      required: ['facts'],
    },
  },
  {
    name: 'recall',
    description:
      'Search your memory for facts about the user. Use when you need to recall something about the user or when they ask "what do you know about me?".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search term to filter memories (e.g. "food", "family", "work"). Leave empty to get all memories.',
        },
      },
    },
  },
  {
    name: 'forget',
    description:
      'Remove a specific fact from memory. Use when the user asks you to forget something.',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The exact fact text to remove from memory.',
        },
      },
      required: ['fact'],
    },
  },
  {
    name: 'add_to_list',
    description:
      'Add one or more items to a named list (notes, shopping, to-do, etc). Creates the list if it doesn\'t exist. Default list is "general".',
    parameters: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Name of the list (e.g. "shopping", "todo", "ideas"). Default: "general".' },
        items: { type: 'array', items: { type: 'string' }, description: 'Items to add to the list.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'get_list',
    description: 'Retrieve all items from a named list.',
    parameters: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Name of the list to retrieve. Default: "general".' },
      },
    },
  },
  {
    name: 'remove_from_list',
    description: 'Remove or check off items from a named list by their text (partial match supported).',
    parameters: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Name of the list. Default: "general".' },
        items: { type: 'array', items: { type: 'string' }, description: 'Items to remove (partial text match).' },
      },
      required: ['items'],
    },
  },
  {
    name: 'list_all_lists',
    description: 'Show all list names the user has created.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_reminder',
    description:
      'Schedule a proactive WhatsApp message (reminder/notification) at a specific time. Rio will SEND the message automatically — use for "remind me", "notify me at", "send me a message tomorrow at", "תזכיר לי", "שלח לי התראה". Supports one-time and recurring (daily/weekly/monthly). Use target_number to message another person (e.g. remind Sapir). ALWAYS call this tool when user wants a future message — never say you cannot schedule messages.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The reminder text (e.g. "Take medicine", "Call dentist").' },
        trigger_at: { type: 'string', description: 'When to trigger the reminder, in ISO 8601 format with timezone (e.g. "2026-04-10T20:00:00+03:00"). Use Asia/Jerusalem timezone.' },
        recurring: {
          type: 'object',
          description: 'For recurring reminders. Set type to "daily", "weekly", or "monthly".',
          properties: { type: { type: 'string', description: '"daily", "weekly", or "monthly"' } },
        },
        target_number: { type: 'string', description: 'Phone number to send the reminder TO (for "remind Sapir to..." type requests). Leave empty to remind the current user.' },
      },
      required: ['text', 'trigger_at'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all active (unsent) reminders for the user.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'delete_reminder',
    description: 'Delete a specific reminder by its ID.',
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'The reminder ID to delete.' },
      },
      required: ['reminder_id'],
    },
  },
  {
    name: 'search_places',
    description:
      'Search for places, restaurants, shops, services, etc. using Google Maps. Use when the user asks "where can I find...", "restaurants near...", "closest pharmacy", etc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "sushi restaurant in Tel Aviv", "closest pharmacy to Herzliya").' },
        latitude: { type: 'number', description: 'Optional latitude for location-biased search.' },
        longitude: { type: 'number', description: 'Optional longitude for location-biased search.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_directions',
    description:
      'Get directions between two locations using Google Maps. Returns distance, duration, and step-by-step directions. Use when the user asks "how to get to...", "directions from... to...", "how far is...".',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Starting location (address or place name).' },
        destination: { type: 'string', description: 'Destination (address or place name).' },
        mode: { type: 'string', description: 'Travel mode: "driving" (default), "walking", "bicycling", or "transit".' },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'add_expense',
    description:
      'Record an expense. Use when the user says "I spent...", "add expense...", or sends a receipt image that has been analyzed. Auto-categorize when possible (food, transport, shopping, health, entertainment, bills, etc).',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount spent.' },
        currency: { type: 'string', description: 'Currency code (default: ILS). Examples: ILS, USD, EUR.' },
        category: { type: 'string', description: 'Expense category: food, transport, shopping, health, entertainment, bills, housing, education, or general.' },
        description: { type: 'string', description: 'Short description of the expense (e.g. "Sushi dinner", "Uber to airport").' },
        date: { type: 'string', description: 'Date of expense in YYYY-MM-DD format. Default: today.' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'list_expenses',
    description: 'List recent expenses with optional date range and category filter.',
    parameters: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date filter (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'End date filter (YYYY-MM-DD).' },
        category: { type: 'string', description: 'Category filter (e.g. "food", "transport").' },
      },
    },
  },
  {
    name: 'expense_summary',
    description: 'Get a monthly expense summary with totals by category. Use when the user asks "how much did I spend this month?" or "expense report".',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Month number (1-12). Default: current month.' },
        year: { type: 'number', description: 'Year. Default: current year.' },
      },
    },
  },
  {
    name: 'search_drive',
    description:
      'Search the user\'s Google Drive for files. Supports Google Drive search syntax. Use when the user asks to find a file, document, presentation, or spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Google Drive search query. Examples: "name contains \'report\'", "mimeType=\'application/pdf\'", "modifiedTime > \'2026-01-01\'". For simple searches, use "name contains \'keyword\'".',
        },
        max_results: { type: 'number', description: 'Maximum results to return (default: 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_drive_file',
    description:
      'Read the contents of a file from Google Drive. Supports Google Docs, Sheets (as CSV), Slides (as text), and text files. Use after search_drive to read a specific file.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Google Drive file ID.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'create_document',
    description:
      'Create a new Google Doc in the user\'s Drive. Use when the user asks to create a document, save notes to Drive, or write meeting notes.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title.' },
        content: { type: 'string', description: 'Initial document content (plain text).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_sticker',
    description:
      'Create a WhatsApp sticker from the last image the user sent, or from text. Use when the user asks to make a sticker, convert an image to sticker, or create a text sticker.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to turn into a sticker (only if no image was sent).' },
      },
    },
  },
  {
    name: 'generate_qr',
    description:
      'Generate a QR code image from text, URL, phone number, or any data. Use when the user asks to create a QR code.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text/URL/data to encode in the QR code.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'translate',
    description:
      'Translate text from one language to another. Use when the user explicitly asks to translate something, says "translate to...", or "how do you say... in...".',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to translate.' },
        targetLanguage: { type: 'string', description: 'Target language (e.g. "English", "Arabic", "French", "Russian", "Spanish").' },
        sourceLanguage: { type: 'string', description: 'Source language (optional, auto-detected if not given).' },
      },
      required: ['text', 'targetLanguage'],
    },
  },
  {
    name: 'summarize_emails',
    description:
      'Summarize recent or unread emails. Use when the user asks "summarize my emails", "any important emails?", "what did I miss this week?", etc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (default: "is:unread"). e.g. "is:unread", "newer_than:7d", "from:boss@company.com".' },
        maxResults: { type: 'number', description: 'Max emails to summarize (default: 10, max: 20).' },
      },
    },
  },
  {
    name: 'download_video',
    description:
      'Download a video from YouTube, TikTok, Instagram Reels, or other supported platforms. Use when the user sends a video link and asks to download it.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The video URL to download.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'summarize_link',
    description:
      'Get info about a video or web link (title, duration, description). Use when the user sends a YouTube/TikTok link and asks what it is about or to summarize it.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to get info about.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'create_invoice',
    description:
      'Create a PDF invoice. Use when the user asks to generate an invoice, receipt, or bill for a client.',
    parameters: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string', description: 'Invoice number.' },
        date: { type: 'string', description: 'Invoice date (e.g. "2026-04-10").' },
        sellerName: { type: 'string', description: 'Seller/business name.' },
        sellerAddress: { type: 'string', description: 'Seller address.' },
        sellerPhone: { type: 'string', description: 'Seller phone.' },
        sellerEmail: { type: 'string', description: 'Seller email.' },
        buyerName: { type: 'string', description: 'Client/buyer name.' },
        buyerAddress: { type: 'string', description: 'Client address.' },
        buyerPhone: { type: 'string', description: 'Client phone.' },
        buyerEmail: { type: 'string', description: 'Client email.' },
        items: {
          type: 'array',
          description: 'Line items on the invoice.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              price: { type: 'number' },
            },
          },
        },
        currency: { type: 'string', description: 'Currency code (default: ILS).' },
        taxRate: { type: 'number', description: 'Tax rate percentage (default: 17 for Israel VAT).' },
        notes: { type: 'string', description: 'Additional notes.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'daily_briefing',
    description:
      'Generate the daily morning briefing with calendar, emails, and personal summary. Use when the user asks for "briefing", "morning summary", "what do I have today", "תדריך בוקר".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'book_place',
    description:
      'Search for a place/restaurant/service and provide booking links. Use when the user asks to book a table, reserve a place, find a business to book.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for (e.g. "sushi restaurant in Tel Aviv", "hair salon in Ramat Gan").' },
        date: { type: 'string', description: 'Desired date/time (optional).' },
        partySize: { type: 'number', description: 'Number of people (optional).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'post_to_instagram',
    description:
      'Post an image to Instagram. Use when the user asks to post something on Instagram or social media. Requires an image URL.',
    parameters: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'Public URL of the image to post.' },
        caption: { type: 'string', description: 'Instagram post caption/text.' },
      },
      required: ['imageUrl', 'caption'],
    },
  },
  {
    name: 'smart_home',
    description:
      'Control or query smart home devices (lights, plugs, thermostats). Use when the user asks to "turn off the lights", "set temperature", "list my devices", etc.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: "list", "on", "off", "set_temperature", "status".' },
        deviceName: { type: 'string', description: 'Name of the device (e.g. "living room lights", "bedroom AC").' },
        value: { type: 'string', description: 'Value to set (e.g. temperature "22", brightness "50%").' },
      },
      required: ['action'],
    },
  },
  {
    name: 'slack_unread',
    description:
      'Get unread Slack messages. Use when the user asks "what\'s new on Slack", "any Slack messages", "מה חדש בסלאק".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'slack_read_channel',
    description:
      'Read recent messages from a Slack channel or DM. Use when the user asks to see messages from a specific channel.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g. "general", "random") or channel ID.' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'slack_send',
    description:
      'Send a message to a Slack channel. Use when the user asks to send/write something in Slack.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name or ID.' },
        text: { type: 'string', description: 'Message text to send.' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'search_shufersal',
    description:
      'Search for products on Shufersal supermarket. Use when the user asks to find/order products from Shufersal/supermarket. Returns a search link.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search query (e.g. "חלב תנובה", "bread", "שוקולד").' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_wolt',
    description:
      'Search for restaurants/food on Wolt. Use when the user asks to order food, find restaurants on Wolt. Returns a search link.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "פיצה", "sushi", "המבורגר").' },
        city: { type: 'string', description: 'City in English (e.g. "tel-aviv", "jerusalem", "haifa"). Default: tel-aviv.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_bit',
    description:
      'Generate a Bit payment link to send money. Use when the user asks to send money via Bit, pay someone with Bit.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Recipient phone number.' },
        amount: { type: 'number', description: 'Amount in NIS.' },
        note: { type: 'string', description: 'Payment note/reason.' },
      },
    },
  },
  {
    name: 'connect_google',
    description:
      'Generate a Google account connection link for the user. Use when the user asks to connect Google, link Gmail, connect calendar, or asks how to enable email/calendar/drive features. Also use when the user asks "how do I connect?" or "חבר את גוגל" or "חיבור למייל" etc.',
    parameters: { type: 'object', properties: {} },
  },
];

/**
 * Execute a tool call. The userId is passed through so Gmail/Calendar
 * use the correct user's OAuth credentials.
 */
async function executeTool(name, args, userId, opts = {}) {
  if (opts.plan) {
    const blocked = getUpgradeMessage(name, opts.plan);
    if (blocked) return blocked;
  }
  console.log(`[tools] Executing: ${name}`);

  switch (name) {
    case 'web_search':
      return webSearch(args.query);

    case 'lookup_contact':
      return { contacts: await searchContacts(args.name, userId) };

    case 'send_whatsapp_message': {
      const displayNum = formatPhoneForDisplay(args.phone_number);
      try {
        await sendMessageToNumber(args.phone_number, args.message);
        return { status: 'Message sent successfully', to: displayNum };
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        const code = err.response?.data?.error?.code || err.response?.status;
        console.error(`[tools] WhatsApp send failed (${code}):`, detail);
        if (code === 131030 || /not in allowed list/i.test(detail)) {
          return { error: `Cannot send message to ${displayNum}. This number is not in the WhatsApp allowed list. The app owner needs to add this number in Meta Business Manager > WhatsApp > API Setup, or switch the app to Live mode.` };
        }
        if (code === 131047 || /re-engage|24|template/i.test(detail)) {
          return { error: `Cannot send free-form message to ${displayNum}. The recipient needs to message Rio first (WhatsApp 24-hour policy). After they send Rio any message, you can send them messages for 24 hours.` };
        }
        return { error: `Failed to send message to ${displayNum}: ${detail}` };
      }
    }

    case 'search_emails':
    case 'read_email':
    case 'send_email':
    case 'get_unread_count':
    case 'list_calendar_events':
    case 'create_calendar_event':
    case 'update_calendar_event':
    case 'delete_calendar_event': {
      if (!await isAuthenticated(userId)) {
        return { error: `חשבון Google לא מחובר. לחץ על הלינק כדי לחבר:\n${oauthStartUrl(userId)}`, not_connected: true };
      }
      switch (name) {
        case 'search_emails': return searchEmails(args.query, args.max_results || 5, userId);
        case 'read_email': return readEmail(args.message_id, userId);
        case 'send_email': return sendEmail(args.to, args.subject, args.body, userId);
        case 'get_unread_count': return { unread: await getUnreadCount(userId) };
        case 'list_calendar_events': return listEvents({ maxResults: args.max_results || 10, timeMin: args.time_min, timeMax: args.time_max, userId });
        case 'create_calendar_event': {
          let endTime = args.end_time;
          if (args.start_time && !endTime) {
            const start = new Date(args.start_time.includes('+') ? args.start_time : `${args.start_time}+03:00`);
            if (!Number.isNaN(start.getTime())) {
              endTime = new Date(start.getTime() + 30 * 60 * 1000).toISOString();
            }
          }
          const result = await createEvent({
            summary: args.summary || 'פגישה',
            startTime: args.start_time,
            endTime,
            description: args.description,
            location: args.location,
            attendees: args.attendees,
            userId,
          });
          console.log(`[calendar] Created event id=${result.id} link=${result.htmlLink || 'n/a'}`);
          return { status: 'created', ...result };
        }
        case 'update_calendar_event': {
          if (!args.event_id && (args.search || args.summary)) {
            const { findMatchingEvents } = require('./calendar');
            const matches = await findMatchingEvents({
              userId,
              search: args.search || args.summary,
              startTime: args.start_time,
            });
            if (matches.length === 1) args.event_id = matches[0].id;
            else if (matches.length > 1) {
              return { error: 'נמצאו כמה פגישות — ציין איזו לעדכן.', matches: matches.map((e) => ({ id: e.id, summary: e.summary, start: e.start })) };
            } else return { error: 'לא נמצאה פגישה לעדכון.' };
          }
          if (!args.event_id) return { error: 'event_id required, or provide search/summary to find the event.' };
          const updated = await updateEvent(args.event_id, { summary: args.summary, startTime: args.start_time, endTime: args.end_time, description: args.description, location: args.location, attendees: args.attendees, userId });
          console.log(`[calendar] Updated event id=${updated.id}`);
          return { status: 'updated', ...updated };
        }
        case 'delete_calendar_event': {
          const result = await cancelEvent({
            eventId: args.event_id,
            search: args.search || args.summary,
            startTime: args.start_time,
            userId,
          });
          if (result.status === 'cancelled') {
            console.log(`[calendar] Cancelled event id=${result.eventId} summary=${result.summary || ''}`);
          }
          return result;
        }
      }
      break;
    }

    case 'edit_image': {
      const img = getUserImage(userId);
      if (!img) return { error: 'No recent image found. Please send an image first, then ask me to edit it.' };
      const result = await editImage(img.buffer, img.mimeType, args.instruction);
      return {
        _media: { type: 'image', path: result.imagePath, mimeType: result.mimeType },
        status: 'Image edited successfully',
        description: result.textResponse || 'Image edited as requested.',
      };
    }

    case 'generate_image': {
      const result = await generateImage(args.prompt);
      return {
        _media: { type: 'image', path: result.imagePath, mimeType: result.mimeType },
        status: 'Image generated successfully',
        description: result.textResponse || 'Image created as requested.',
      };
    }

    case 'generate_music': {
      const result = await generateMusic(args.prompt, args.full_song || false);
      const response = {
        _media: { type: 'audio', path: result.audioPath, mimeType: result.mimeType },
        status: 'Music generated successfully',
      };
      if (result.lyrics) response.lyrics = result.lyrics;
      return response;
    }

    case 'remember':
      return remember(userId, args.facts);

    case 'recall':
      return recall(userId, args.query);

    case 'forget':
      return forget(userId, args.fact);

    case 'add_to_list': {
      const listName = args.list_name || 'general';
      const data = await getList(userId, listName);
      const items = data.items || [];
      const now = new Date().toISOString();
      for (const text of args.items) {
        items.push({ text, done: false, createdAt: now });
      }
      await setList(userId, listName, { items });
      return { status: `Added ${args.items.length} item(s) to "${listName}"`, totalItems: items.length };
    }

    case 'get_list': {
      const listName = args.list_name || 'general';
      const data = await getList(userId, listName);
      const items = data.items || [];
      if (!items.length) return { list: listName, items: [], message: `The "${listName}" list is empty.` };
      return { list: listName, items: items.map((it, i) => ({ index: i + 1, text: it.text, done: it.done })) };
    }

    case 'remove_from_list': {
      const listName = args.list_name || 'general';
      const data = await getList(userId, listName);
      let items = data.items || [];
      const removed = [];
      for (const query of args.items) {
        const q = query.toLowerCase();
        const idx = items.findIndex((it) => it.text.toLowerCase().includes(q));
        if (idx !== -1) {
          removed.push(items[idx].text);
          items.splice(idx, 1);
        }
      }
      await setList(userId, listName, { items });
      return { removed, remainingItems: items.length };
    }

    case 'list_all_lists': {
      const names = await getAllListNames(userId);
      if (!names.length) return { lists: [], message: 'No lists created yet.' };
      return { lists: names };
    }

    case 'create_reminder': {
      let targetNumber = args.target_number || null;
      if (targetNumber) {
        const normalized = targetNumber.replace(/[^0-9]/g, '');
        if (!/^\d{10,15}$/.test(normalized)) {
          return { error: 'Invalid target phone number format.' };
        }
        targetNumber = normalized;
      }
      const created = await createReminder(userId, {
        text: args.text,
        triggerAt: args.trigger_at,
        recurring: args.recurring,
        targetNumber,
      });
      const when = new Date(args.trigger_at).toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const toLabel = targetNumber ? `למספר ${targetNumber}` : 'אליך';
      return {
        ...created,
        status: 'scheduled',
        message: `אשלח הודעה ${toLabel} ב-${when}${created.recurring !== 'none' ? ` (חוזר: ${created.recurring})` : ''}.`,
      };
    }

    case 'list_reminders':
      return { reminders: await listReminders(userId) };

    case 'delete_reminder':
      return removeReminder(userId, args.reminder_id);

    case 'search_places': {
      let location;
      if (args.latitude && args.longitude) {
        location = { lat: args.latitude, lng: args.longitude };
      } else {
        try {
          const saved = await getLocation(userId);
          if (saved) location = { lat: saved.lat, lng: saved.lng };
        } catch { /* no saved location */ }
      }
      const results = await searchPlaces(args.query, { location });
      return {
        places: results,
        locationSource: location ? (args.latitude ? 'provided' : 'saved') : 'none',
        hint: !location ? 'No location on file. Ask the user to share their location for better results.' : undefined,
      };
    }

    case 'get_directions': {
      let origin = args.origin;
      if (!origin || origin === 'my location' || origin === 'here' || origin === 'המיקום שלי') {
        try {
          const saved = await getLocation(userId);
          if (saved) origin = `${saved.lat},${saved.lng}`;
        } catch { /* no saved location */ }
      }
      if (!origin) {
        return { error: 'I need your starting location. Please share your location or tell me where you are.' };
      }
      return getDirections(origin, args.destination, { mode: args.mode });
    }

    case 'add_expense':
      return trackExpense(userId, {
        amount: args.amount,
        currency: args.currency,
        category: args.category,
        description: args.description,
        date: args.date,
      });

    case 'list_expenses':
      return listUserExpenses(userId, {
        startDate: args.start_date,
        endDate: args.end_date,
        category: args.category,
      });

    case 'expense_summary':
      return expenseSummary(userId, { month: args.month, year: args.year });

    case 'search_drive':
    case 'read_drive_file':
    case 'create_document': {
      if (!await isAuthenticated(userId)) {
        return { error: `חשבון Google לא מחובר. לחץ על הלינק כדי לחבר:\n${oauthStartUrl(userId)}`, not_connected: true };
      }
      switch (name) {
        case 'search_drive': return { files: await searchDrive(args.query, userId, args.max_results || 10) };
        case 'read_drive_file': return readDriveFile(args.file_id, userId);
        case 'create_document': return createDocument(args.title, args.content, userId);
      }
      break;
    }

    case 'create_sticker': {
      const userImg = getUserImage(userId);
      if (userImg) {
        const stickerPath = await imageToSticker(userImg.buffer);
        return { _media: { type: 'sticker', path: stickerPath, mimeType: 'image/webp' }, status: 'Sticker created from your image!' };
      }
      if (args.text) {
        const stickerPath = await textToSticker(args.text);
        return { _media: { type: 'sticker', path: stickerPath, mimeType: 'image/webp' }, status: 'Text sticker created!' };
      }
      return { error: 'Send me an image first, or provide text to make a sticker from.' };
    }

    case 'generate_qr': {
      const qrPath = await generateQR(args.content);
      return { _media: { type: 'image', path: qrPath, mimeType: 'image/png' }, status: `QR code created for: ${args.content}` };
    }

    case 'translate':
      return {
        _translate: true,
        text: args.text,
        targetLanguage: args.targetLanguage,
        sourceLanguage: args.sourceLanguage || 'auto',
      };

    case 'summarize_emails': {
      if (!await isAuthenticated(userId)) {
        return { error: `חשבון Google לא מחובר. לחץ על הלינק כדי לחבר:\n${oauthStartUrl(userId)}`, not_connected: true };
      }
      const query = args.query || 'is:unread';
      const max = Math.min(args.maxResults || 10, 20);
      const emails = await searchEmails(query, max, userId);
      if (!emails?.length) return { message: 'No emails found matching your query.' };
      return {
        _summarize: true,
        emails: emails.map((e) => ({
          from: e.from,
          subject: e.subject,
          date: e.date,
          snippet: e.snippet || e.body?.substring(0, 200),
        })),
        totalFound: emails.length,
      };
    }

    case 'download_video': {
      try {
        const filePath = await downloadVideo(args.url);
        return { _media: { type: 'video', path: filePath, mimeType: 'video/mp4' }, status: 'Video downloaded!' };
      } catch (err) {
        return { error: `Failed to download video: ${err.message}. The video might be too large (max 16MB) or from an unsupported source.` };
      }
    }

    case 'summarize_link': {
      if (isVideoLink(args.url)) {
        try {
          const info = await getVideoInfo(args.url);
          return {
            title: info.title,
            duration: info.duration ? `${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}` : 'unknown',
            uploader: info.uploader,
            views: info.viewCount,
            description: info.description,
            url: info.url,
          };
        } catch {
          return { error: 'Could not get video info. Try sending the link with a question and I\'ll use web search instead.' };
        }
      }
      return { suggestion: `This is a web link (not a video). Use the web_search tool with query "summarize ${args.url}" to get information about this page.` };
    }

    case 'create_invoice': {
      const pdfPath = await createInvoice({
        invoiceNumber: args.invoiceNumber,
        date: args.date,
        from: { name: args.sellerName, address: args.sellerAddress, phone: args.sellerPhone, email: args.sellerEmail },
        to: { name: args.buyerName, address: args.buyerAddress, phone: args.buyerPhone, email: args.buyerEmail },
        items: args.items,
        currency: args.currency,
        taxRate: args.taxRate,
        notes: args.notes,
      });
      return { _media: { type: 'document', path: pdfPath, mimeType: 'application/pdf', filename: `invoice_${args.invoiceNumber || Date.now()}.pdf` }, status: 'Invoice created!' };
    }

    case 'daily_briefing':
      return { briefing: await buildBriefing(userId) };

    case 'book_place': {
      const loc = await getLocation(userId).catch(() => null);
      const results = await searchPlaces(args.query, loc ? { location: { lat: loc.lat, lng: loc.lng } } : undefined);
      return {
        places: results.map((p) => ({
          name: p.name,
          address: p.address,
          rating: p.rating,
          totalRatings: p.totalRatings,
          openNow: p.openNow,
          mapsUrl: p.mapsUrl,
          bookingTip: `Search Google for "${p.name} reservation" or call directly.`,
        })),
        hint: args.date ? `Looking for availability on ${args.date}` : null,
        message: 'I found these options. Unfortunately I cannot make a reservation directly — you\'ll need to contact the place. Here are the details:',
      };
    }

    case 'post_to_instagram':
      return postToInstagram({ imageUrl: args.imageUrl, caption: args.caption });

    case 'smart_home':
      if (args.action === 'list') return listDevices(userId);
      return controlDevice(userId, { deviceName: args.deviceName, action: args.action, value: args.value });

    case 'slack_unread':
      return getUnreadMessages(userId);

    case 'slack_read_channel':
      return getRecentMessages(userId, args.channel);

    case 'slack_send':
      return sendSlackMessage(userId, args.channel, args.text);

    case 'search_shufersal':
      return getShufersal(args.query);

    case 'search_wolt':
      return getWolt(args.query, args.city);

    case 'send_bit':
      return getBitPayLink({ phone: args.phone, amount: args.amount, note: args.note });

    case 'connect_google': {
      const link = oauthStartUrl(userId);
      const alreadyConnected = await isAuthenticated(userId);
      if (alreadyConnected) {
        return {
          status: 'already_connected',
          message: 'חשבון Google כבר מחובר! אפשר להשתמש ביומן, מיילים ו-Drive.',
        };
      }
      return {
        status: 'link_generated',
        link,
        message: 'שתף את הלינק הזה עם המשתמש כדי לחבר את חשבון Google שלו. הלינק מאפשר גישה ל-Gmail, יומן ו-Google Drive.',
        instructions: [
          'לחץ על הלינק למטה',
          'בחר את חשבון Google שלך',
          'אשר את ההרשאות',
          'חזור לוואטסאפ — הכל מוכן!',
        ],
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const PUBLIC_TOOLS = new Set([
  'web_search', 'generate_image', 'edit_image', 'generate_music',
  'search_places', 'get_directions', 'translate', 'generate_qr',
]);

const BASIC_TOOLS = new Set([
  ...PUBLIC_TOOLS, 'connect_google',
  'add_to_list', 'get_list', 'remove_from_list', 'list_all_lists',
  'create_sticker', 'summarize_link', 'book_place',
  'search_shufersal', 'search_wolt', 'send_bit',
  'create_reminder', 'list_reminders', 'delete_reminder',
]);

/** Always available to pro/admin when message has no keyword match (prevents tools=0 hallucinations). */
const CORE_OWNER_TOOLS = new Set([
  'web_search',
  'connect_google',
  'list_calendar_events',
  'create_calendar_event',
  'delete_calendar_event',
  'update_calendar_event',
  'search_emails',
  'read_email',
  'get_unread_count',
  'lookup_contact',
  'send_whatsapp_message',
  'generate_image',
  'generate_music',
  'create_reminder',
  'list_reminders',
  'delete_reminder',
]);

const { isProOnly, getUserPlan } = require('./users');

const TOOL_CATEGORIES = [
  { keywords: /חפש|search|מזג|weather|חדשות|news|מניה|stock|שער|מטבע|currency|ביטקוין|bitcoin|crypto|כדורגל|football|soccer|score|תוצאות|מה קורה|what.?s happen|טרנד|trend|wiki|מידע על/i,
    tools: ['web_search'] },
  { keywords: /תשלח|שלח|הודעה ל|message|send.*to|תגיד ל|תודיע|תעדכן את|forward|העבר/i,
    tools: ['send_whatsapp_message', 'lookup_contact'] },
  { keywords: /מייל|אימייל|email|gmail|inbox|דואר/i,
    tools: ['search_emails', 'read_email', 'send_email', 'get_unread_count', 'summarize_emails', 'connect_google'] },
  { keywords: /יומן|calendar|פגישה|meeting|אירוע|event|תור|appointment|לוז|schedule|קבע|תקבע|תזמן|תוסיף ליומן|add to calendar|בטל|ביטול|מחק|הסר|cancel|delete.*(meeting|event|appointment)|remove.*(meeting|event)/i,
    tools: ['list_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'connect_google'] },
  { keywords: /דרייב|drive|מסמך|document|קובץ|file|גוגל דוקס|google doc/i,
    tools: ['search_drive', 'read_drive_file', 'create_document', 'connect_google'] },
  { keywords: /תמונה|image|photo|צייר|draw|paint|עיצוב|design|ציור|illust/i,
    tools: ['generate_image', 'edit_image'] },
  { keywords: /מוזיקה|music|שיר|song|לחן|melody|beat/i,
    tools: ['generate_music'] },
  { keywords: /סטיקר|sticker/i,
    tools: ['create_sticker'] },
  { keywords: /qr|ברקוד|barcode/i,
    tools: ['generate_qr'] },
  { keywords: /תרגם|translate|תרגום|translation/i,
    tools: ['translate'] },
  { keywords: /תזכור|תזכיר|תזכורת|התראה|התרע|notification|alert|remind|הזכר|הזכיר|בעוד שעה|בעוד \d|מחר ב|מחר בשעה|שלח לי (ב|מחר|בשעה)|תשלח לי|message me at|notify|זכור|recall|שכח|forget|זיכרון|memory/i,
    tools: ['remember', 'recall', 'forget', 'create_reminder', 'list_reminders', 'delete_reminder'] },
  { keywords: /רשימה|list|קניות|shopping|todo|משימה|task|הערה|note/i,
    tools: ['add_to_list', 'get_list', 'remove_from_list', 'list_all_lists'] },
  { keywords: /הוצאה|הוצאות|expense|כמה (שילמתי|הוצאתי|עלה)|תעקוב|budget|תקציב/i,
    tools: ['add_expense', 'list_expenses', 'expense_summary'] },
  { keywords: /ניווט|navigate|מסלול|route|direction|קרוב|nearby|מסעדה|restaurant|בית קפה|cafe|חנות|store|מקום|place|הזמנת מקום|reservation|book a table/i,
    tools: ['search_places', 'get_directions', 'book_place'] },
  { keywords: /וידאו|video|youtube|tiktok|instagram.*reel|הורד|download/i,
    tools: ['download_video', 'summarize_link'] },
  { keywords: /סכם.*לינק|summarize.*link|סיכום.*אתר|סיכום.*כתבה|url|https?:\/\//i,
    tools: ['summarize_link', 'web_search'] },
  { keywords: /חשבונית|invoice|קבלה|receipt/i,
    tools: ['create_invoice'] },
  { keywords: /בוקר טוב|good morning|briefing|תקציר.*יום|סיכום.*יום|daily/i,
    tools: ['daily_briefing', 'connect_google'] },
  { keywords: /אינסטגרם|instagram|פוסט|post/i,
    tools: ['post_to_instagram'] },
  { keywords: /בית חכם|smart.?home|אור|light|מזגן|ac|air.?condition/i,
    tools: ['smart_home'] },
  { keywords: /סלאק|slack|channel/i,
    tools: ['slack_unread', 'slack_read_channel', 'slack_send'] },
  { keywords: /שופרסל|shufersal|סופר|supermarket/i,
    tools: ['search_shufersal'] },
  { keywords: /וולט|wolt|משלוח|delivery|אוכל.*הזמנה/i,
    tools: ['search_wolt'] },
  { keywords: /ביט|bit|תשלום|payment|העבר.*כסף|transfer/i,
    tools: ['send_bit'] },
  { keywords: /חבר.*גוגל|connect.*google|חיבור.*gmail|חיבור.*יומן|חיבור.*דרייב/i,
    tools: ['connect_google'] },
  { keywords: /איש.?קשר|contact|מספר.*של|phone.*number/i,
    tools: ['lookup_contact'] },
];

function selectToolsByMessage(messageText) {
  if (!messageText) return new Set();
  const matched = new Set();
  for (const cat of TOOL_CATEGORIES) {
    if (cat.keywords.test(messageText)) {
      cat.tools.forEach(t => matched.add(t));
    }
  }
  return matched;
}

/**
 * Get tool declarations filtered by access level, plan, and message context.
 * - Non-owners (group non-members): PUBLIC_TOOLS only
 * - Basic plan: BASIC_TOOLS
 * - Pro/Admin plan: all tools, filtered by message relevance
 */
function getFilteredDeclarations(isOwner, plan, messageText) {
  let pool;
  if (!isOwner) {
    pool = functionDeclarations.filter((f) => PUBLIC_TOOLS.has(f.name));
  } else if (plan === 'basic') {
    pool = functionDeclarations.filter((f) => BASIC_TOOLS.has(f.name));
  } else {
    pool = functionDeclarations;
  }

  if (!messageText) return pool;

  const relevant = selectToolsByMessage(messageText);
  if (relevant.size === 0) {
    // Pro/admin: never send zero tools — model will hallucinate calendar/email actions
    if (plan === 'admin' || plan === 'pro') {
      return pool.filter((f) => CORE_OWNER_TOOLS.has(f.name));
    }
    return [];
  }

  const filtered = pool.filter((f) => relevant.has(f.name));
  // Calendar/email intents: always include connect_google so OAuth errors are actionable
  if (
    relevant.has('create_calendar_event') ||
    relevant.has('list_calendar_events') ||
    relevant.has('search_emails')
  ) {
    const names = new Set(filtered.map((f) => f.name));
    if (!names.has('connect_google')) {
      const connect = pool.find((f) => f.name === 'connect_google');
      if (connect) filtered.push(connect);
    }
  }
  return filtered;
}

/**
 * Check if a specific tool call is allowed for the user's plan.
 * Returns an upgrade message if blocked, null if allowed.
 */
function getUpgradeMessage(toolName, plan) {
  if (plan === 'admin' || plan === 'pro') return null;
  if (plan === 'basic' && isProOnly(toolName)) {
    const featureMap = {
      search_emails: 'Gmail access', read_email: 'Gmail access', send_email: 'Gmail access', get_unread_count: 'Gmail access',
      list_calendar_events: 'Calendar access', create_calendar_event: 'Calendar access', update_calendar_event: 'Calendar access', delete_calendar_event: 'Calendar access',
      search_drive: 'Google Drive access', read_drive_file: 'Google Drive access', create_document: 'Google Drive access',
      remember: 'persistent memory', recall: 'persistent memory', forget: 'persistent memory',
      create_reminder: 'reminders', list_reminders: 'reminders', delete_reminder: 'reminders',
      add_expense: 'expense tracking', list_expenses: 'expense tracking', expense_summary: 'expense tracking',
      send_whatsapp_message: 'WhatsApp messaging', lookup_contact: 'contact lookup',
      summarize_emails: 'email summaries', download_video: 'video download',
      create_invoice: 'invoice generation', daily_briefing: 'daily briefing',
      slack_unread: 'Slack', slack_read_channel: 'Slack', slack_send: 'Slack',
    };
    const feature = featureMap[toolName] || 'this feature';
    return { error: `This feature (${feature}) is available on Rio Pro. Upgrade to unlock it!\n\nType /upgrade to upgrade your plan.` };
  }
  return null;
}

module.exports = { functionDeclarations, getFilteredDeclarations, executeTool, storeUserImage, getUpgradeMessage };

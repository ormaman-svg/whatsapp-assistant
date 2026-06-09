# WhatsApp Personal Assistant Bot

A secure, multimodal WhatsApp bot powered by **Gemini 2.5 Flash** and the **Meta WhatsApp Cloud API**. Understands and responds via text, images, and voice notes in English and Hebrew.

## Features

- **Strict whitelist security** — only approved phone numbers can interact
- **Text conversations** with persistent session memory (per-user context)
- **Image understanding** — send a photo and ask about it
- **Voice note input** — Gemini listens to and understands your audio
- **Voice note output** — replies with its own spoken voice note (PCM → OGG/Opus conversion via bundled ffmpeg)
- **Bilingual** — English and Hebrew, auto-detected
- **No system ffmpeg required** — uses `ffmpeg-static` npm binary

## Prerequisites

1. **Node.js 18+**
2. A [Google AI Studio](https://aistudio.google.com/apikey) API key (Gemini)
3. A [Meta Developer](https://developers.facebook.com/) account with a WhatsApp Business App configured
4. [ngrok](https://ngrok.com/) for local development

## Quick Start

### 1. Clone & Install

```bash
cd whatsapp-assistant
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Your Google AI Studio API key |
| `WHATSAPP_ACCESS_TOKEN` | Permanent access token from Meta App Dashboard |
| `WHATSAPP_PHONE_NUMBER_ID` | The Phone Number ID from WhatsApp > API Setup |
| `WHATSAPP_VERIFY_TOKEN` | Any secret string you choose (used to verify the webhook) |
| `ALLOWED_NUMBERS` | Comma-separated phone numbers, e.g. `972527305577,1234567890` |
| `PORT` | Server port (default: 3000) |

### 3. Start the Server

```bash
npm start
```

Or with auto-restart on file changes:

```bash
npm run dev
```

### 4. Expose via ngrok

In a separate terminal:

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`).

### 5. Configure the Meta Webhook

1. Go to your [Meta App Dashboard](https://developers.facebook.com/apps/)
2. Navigate to **WhatsApp** > **Configuration** > **Webhook**
3. Click **Edit** and enter:
   - **Callback URL:** `https://abc123.ngrok-free.app/webhook`
   - **Verify Token:** the same value as `WHATSAPP_VERIFY_TOKEN` in your `.env`
4. Click **Verify and Save**
5. Subscribe to the **messages** webhook field

## Usage

- **Text:** Send any text message to chat with the assistant
- **Image:** Send an image (with optional caption as your question) for visual analysis
- **Voice:** Send a voice note and receive a voice note reply
- **`/clear`:** Send this command to reset your conversation history

## Adding Allowed Numbers

Edit the `ALLOWED_NUMBERS` variable in `.env`:

```
ALLOWED_NUMBERS=972527305577,1234567890,4412345678
```

Numbers should be in international format without the `+` prefix. Restart the server after changes.

## Architecture

```
src/
├── index.js                 # Express server, webhook routes, message routing
├── middleware/
│   └── whitelist.js         # Phone number whitelist security
├── services/
│   ├── gemini.js            # Gemini API integration (text, image, audio I/O)
│   └── session.js           # In-memory per-user conversation history
└── utils/
    ├── audio.js             # PCM-to-OGG/Opus conversion via ffmpeg-static
    └── whatsapp.js          # WhatsApp Cloud API utilities (send, download, upload)
```

## Cloud Run (Baileys / Rio)

Baileys keeps a **background WebSocket** to WhatsApp. On Cloud Run, **CPU is throttled by default** when no HTTP request is being handled, so the handshake stalls and you see `timedOut (408)` / `disconnected` forever while `/health` stays up.

After each deploy from source, ensure **CPU is always allocated**:

```bash
gcloud run services update whatsapp-assistant \
  --region=me-west1 --project=YOUR_PROJECT_ID \
  --no-cpu-throttling --min-instances=1
```

(`run.googleapis.com/cpu-throttling` should be `false`.)

## Troubleshooting

- **Webhook verification fails:** Double-check that `WHATSAPP_VERIFY_TOKEN` matches what you entered in Meta's dashboard.
- **Bot doesn't reply:** Check the console logs. Ensure your number is in `ALLOWED_NUMBERS` and the access token is valid.
- **Voice reply fails:** The bot will automatically fall back to a text reply. Check logs for ffmpeg or Gemini errors.
- **"Unauthorized" for your number:** Make sure your number is listed without the `+` prefix in `ALLOWED_NUMBERS`.

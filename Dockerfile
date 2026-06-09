FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 curl ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/tmp /app/tokens && \
    addgroup --system rio && adduser --system --ingroup rio rio && \
    chown -R rio:rio /app

USER rio

EXPOSE 3000

CMD ["node", "src/index.js"]

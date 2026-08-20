# Telegram → Jazz bridge. Build context is the Jazz repo root (see
# docker-compose.yml); Jazz is built from that source and run under Bun.
FROM oven/bun:1

WORKDIR /app

# System Chromium for the create_web_app tool (puppeteer-core screenshots HTML
# the agent writes). puppeteer-core ships no browser, so this is the only one.
#
# ffmpeg is here for ffprobe, which jazz uses to read the duration of audio and
# video attachments — that duration is what its token estimate is based on, so
# without it every voice note is priced at a conservative 60-second default and
# compaction fires earlier than it needs to. macOS hosts fall back to the
# built-in afinfo for audio; Debian has no equivalent, so the bridge that
# actually receives voice notes installs the real thing. Debian ships ffprobe
# only as part of the ffmpeg package.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencies first so the install layer caches across source edits.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Jazz runs from source under Bun; it locates built-in personas/skills by
# walking up to the package.json named "jazz-ai", so the whole tree is copied.
COPY . .

RUN printf '#!/bin/sh\nexec bun /app/src/main.ts "$@"\n' > /usr/local/bin/jazz \
    && chmod +x /usr/local/bin/jazz \
    && chmod +x /app/integrations/telegram-bot/entrypoint.sh

ENV JAZZ_HOME=/data \
    JAZZ_BIN=jazz \
    JAZZ_NO_TUI=1 \
    JAZZ_DISABLE_UPDATE_CHECK=1 \
    JAZZ_BUILTIN_PERSONAS_DIR=/app/personas \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080
ENTRYPOINT ["/app/integrations/telegram-bot/entrypoint.sh"]

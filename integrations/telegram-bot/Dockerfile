# Telegram → Jazz bridge. Build context is the Jazz repo root (see
# docker-compose.yml); Jazz is built from that source and run under Bun.
FROM oven/bun:1

WORKDIR /app

# System Chromium for the create_web_app tool (puppeteer-core screenshots HTML
# the agent writes). puppeteer-core ships no browser, so this is the only one.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation \
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

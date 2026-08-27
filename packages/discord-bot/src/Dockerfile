# Discord → Jazz bridge. Build context is the Jazz repo root (see
# docker-compose.yml); Jazz is built from that source and run under Bun.
FROM oven/bun:1

WORKDIR /app

# System Chromium for the create_web_app tool (puppeteer-core screenshots HTML
# the agent writes). puppeteer-core ships no browser, so this is the only one.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json bun.lock bunfig.toml ./

# A workspace monorepo: bun needs every packages/*/package.json on disk to
# link @jazz/* symlinks in node_modules, so installing before the rest of the
# source is copied would silently skip them (every @jazz/* import then fails
# at runtime, not at build time). Copy everything first and pay for a full
# install on every source change instead — this repo's install is ~2s.
COPY . .
RUN bun install --frozen-lockfile

RUN printf '#!/bin/sh\nexec bun /app/packages/runtime/src/entry.ts "$@"\n' > /usr/local/bin/jazz \
    && chmod +x /usr/local/bin/jazz \
    && chmod +x /app/packages/discord-bot/src/entrypoint.sh

ENV JAZZ_HOME=/data \
    JAZZ_BIN=jazz \
    JAZZ_NO_TUI=1 \
    JAZZ_DISABLE_UPDATE_CHECK=1 \
    JAZZ_BUILTIN_PERSONAS_DIR=/app/personas \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080
ENTRYPOINT ["/app/packages/discord-bot/src/entrypoint.sh"]

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
    chromium fonts-liberation ffmpeg curl jq khal vdirsyncer pass gnupg python3-pip \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Himalaya has no Debian package; install the upstream binary the same way
# the email skill's own install fallback does.
RUN curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh \
    | PREFIX=/usr/local sh

# Debian's vdirsyncer package doesn't pull aiohttp-oauthlib, so its
# google_calendar storage (OAuth) errors "aiohttp-oauthlib not installed" —
# CalDAV+password auth no longer works against Google's calendar backend at
# all, so this is required for calendar access to Google accounts.
RUN pip3 install --break-system-packages --no-cache-dir aiohttp-oauthlib

# Google's CalDAV endpoint rejects the RFC 6764 principal-discovery handshake
# every generic CalDAV client (including vdirsyncer's own google_calendar
# OAuth backend) depends on to auto-configure — confirmed via 403 "Given URL
# is not a homeset URL" even with a valid OAuth token. gcalcli talks to the
# real Calendar REST API v3 instead of CalDAV, so it's what Google accounts
# actually need for calendar access; khal/vdirsyncer stay installed above for
# non-Google CalDAV providers (iCloud, Nextcloud, Fastmail, ...) where
# discovery isn't broken. --ignore-installed avoids fighting Debian's
# python3-typing-extensions for a package apt didn't install with pip
# metadata; the aiostream pin keeps pip from upgrading past what vdirsyncer
# requires.
RUN pip3 install --break-system-packages --ignore-installed --no-cache-dir "aiostream<0.5.0" gcalcli

# himalaya/khal/vdirsyncer/pass/gnupg all default to files under $HOME, which
# lives on the container's writable layer and is lost on every rebuild or
# recreate. Point their config/data/secrets at the same /data volume Jazz
# already persists (JAZZ_HOME below) so `docker compose exec` setup survives.
ENV XDG_CONFIG_HOME=/data/xdg-config \
    XDG_DATA_HOME=/data/xdg-data \
    XDG_STATE_HOME=/data/xdg-state \
    GNUPGHOME=/data/gnupg \
    PASSWORD_STORE_DIR=/data/password-store

COPY package.json bun.lock bunfig.toml ./

# Workspace packages must be on disk before install, or bun skips their
# node_modules/@jazz/* symlinks.
COPY . .
RUN bun install --frozen-lockfile

RUN printf '#!/bin/sh\nexec bun /app/packages/runtime/src/entry.ts "$@"\n' > /usr/local/bin/jazz \
    && chmod +x /usr/local/bin/jazz \
    && chmod +x /app/packages/telegram-bot/src/entrypoint.sh

ENV JAZZ_HOME=/data \
    JAZZ_BIN=jazz \
    JAZZ_NO_TUI=1 \
    JAZZ_DISABLE_UPDATE_CHECK=1 \
    JAZZ_BUILTIN_PERSONAS_DIR=/app/personas \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080
ENTRYPOINT ["/app/packages/telegram-bot/src/entrypoint.sh"]

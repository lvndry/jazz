#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"
JAZZ_TELEGRAM_PROVIDER="${JAZZ_TELEGRAM_PROVIDER:-openai}"
JAZZ_TELEGRAM_MODEL="${JAZZ_TELEGRAM_MODEL:-gpt-5.4}"
# Reasoning effort. Keep it in sync with the model: reasoning-capable models
# (gpt-5.4, qwen3, …) can use low|medium|high; models without it (mistral-small,
# gemma, …) 400 unless this is "disable".
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/integrations/telegram-bot/agent.telegram.json"

mkdir -p "${JAZZ_HOME}/agents"

# Directories for the email/calendar skills' XDG-relocated config, data, GPG
# keyring, and pass store (see Dockerfile) — created up front so the first
# `docker compose exec` setup session has somewhere to write.
mkdir -p "${XDG_CONFIG_HOME:-/data/xdg-config}" "${XDG_DATA_HOME:-/data/xdg-data}" \
  "${XDG_STATE_HOME:-/data/xdg-state}" "${PASSWORD_STORE_DIR:-/data/password-store}"
mkdir -p "${GNUPGHOME:-/data/gnupg}"
chmod 700 "${GNUPGHOME:-/data/gnupg}"

# Merge the bridge-managed keys into config.json, leaving anything the operator
# put there alone — the volume outlives the container, so writing this file
# wholesale discarded their settings on every restart. Keys come from the
# environment so no secret is ever baked into the image.
# Nothing here needs to force streaming: the bridge asks for reasoning and text
# events, and jazz selects the streaming path for those on its own.
bun /app/integrations/shared/write-bridge-config.ts "${JAZZ_HOME}/config.json"

# Seed / refresh the template agent that per-chat agents are cloned from.
sed -e "s#__JAZZ_PROVIDER__#${JAZZ_TELEGRAM_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_TELEGRAM_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/telegram.json"
echo "Seeded agent 'telegram' (model=${JAZZ_TELEGRAM_PROVIDER}/${JAZZ_TELEGRAM_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/integrations/telegram-bot/bridge.ts

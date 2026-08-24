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

# Write config.json. When BRAVE_API_KEY is set, configure Brave as the web_search
# provider — the key comes from the environment so it's never baked into the image.
# Nothing here needs to force streaming: the bridge asks for reasoning and text
# events, and jazz selects the streaming path for those on its own.
if [ -n "${BRAVE_API_KEY:-}" ]; then
  cat > "${JAZZ_HOME}/config.json" <<JSON
{"web_search":{"provider":"brave","brave":{"api_key":"${BRAVE_API_KEY}"}}}
JSON
  echo "Configured Brave web search"
else
  printf '{}\n' > "${JAZZ_HOME}/config.json"
fi

# Seed / refresh the template agent that per-chat agents are cloned from.
sed -e "s#__JAZZ_PROVIDER__#${JAZZ_TELEGRAM_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_TELEGRAM_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/telegram.json"
echo "Seeded agent 'telegram' (model=${JAZZ_TELEGRAM_PROVIDER}/${JAZZ_TELEGRAM_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/integrations/telegram-bot/bridge.ts

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

# Enable streaming so `jazz run --events` actually emits live-progress events.
# Without this, non-TTY runs (like this bridge) fall back to batch mode and
# emit nothing, and the progress bubble would never update.
printf '{"output":{"streaming":{"enabled":true}}}\n' > "${JAZZ_HOME}/config.json"

# Seed / refresh the template agent that per-chat agents are cloned from.
sed -e "s#__JAZZ_PROVIDER__#${JAZZ_TELEGRAM_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_TELEGRAM_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/telegram.json"
echo "Seeded agent 'telegram' (model=${JAZZ_TELEGRAM_PROVIDER}/${JAZZ_TELEGRAM_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/integrations/telegram-bot/bridge.ts

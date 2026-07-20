#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"
JAZZ_TELEGRAM_MODEL="${JAZZ_TELEGRAM_MODEL:-qwen3.6:27b}"
# Reasoning effort. Keep this in sync with the model: thinking-capable models
# (qwen3, …) can use low|medium|high; models without a thinking capability
# (mistral-small, gemma, …) 400 unless this is "disable".
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/integrations/telegram-bot/agent.telegram.json"

mkdir -p "${JAZZ_HOME}/agents"

# Seed / refresh the template agent that per-chat agents are cloned from.
sed -e "s#__JAZZ_MODEL__#${JAZZ_TELEGRAM_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/telegram.json"
echo "Seeded agent 'telegram' (model=ollama/${JAZZ_TELEGRAM_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/integrations/telegram-bot/bridge.ts

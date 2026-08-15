#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"
JAZZ_DISCORD_PROVIDER="${JAZZ_DISCORD_PROVIDER:-openai}"
JAZZ_DISCORD_MODEL="${JAZZ_DISCORD_MODEL:-gpt-5.4}"
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/integrations/discord-bot/agent.discord.json"

mkdir -p "${JAZZ_HOME}/agents"

# Streaming is required so `jazz run --events` emits live-progress events
# (non-TTY runs otherwise fall back to batch mode and emit nothing).
if [ -n "${BRAVE_API_KEY:-}" ]; then
  cat > "${JAZZ_HOME}/config.json" <<JSON
{"output":{"streaming":{"enabled":true}},"web_search":{"provider":"brave","brave":{"api_key":"${BRAVE_API_KEY}"}}}
JSON
  echo "Configured Brave web search"
else
  printf '{"output":{"streaming":{"enabled":true}}}\n' > "${JAZZ_HOME}/config.json"
fi

sed -e "s#__JAZZ_PROVIDER__#${JAZZ_DISCORD_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_DISCORD_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/discord.json"
echo "Seeded agent 'discord' (model=${JAZZ_DISCORD_PROVIDER}/${JAZZ_DISCORD_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/integrations/discord-bot/bridge.ts

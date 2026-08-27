#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"
JAZZ_DISCORD_PROVIDER="${JAZZ_DISCORD_PROVIDER:-openai}"
JAZZ_DISCORD_MODEL="${JAZZ_DISCORD_MODEL:-gpt-5.4}"
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/packages/discord-bot/src/agent.discord.json"

mkdir -p "${JAZZ_HOME}/agents"

# Merge the bridge-managed keys into config.json, leaving anything the operator
# put there alone — the volume outlives the container, so writing this file
# wholesale discarded their settings on every restart.
# The bridge asks for reasoning and text events, and jazz selects the streaming path
# for those on its own — nothing here needs to force it.
bun /app/packages/bot-shared/src/write-bridge-config.ts "${JAZZ_HOME}/config.json"

sed -e "s#__JAZZ_PROVIDER__#${JAZZ_DISCORD_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_DISCORD_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/discord.json"
echo "Seeded agent 'discord' (model=${JAZZ_DISCORD_PROVIDER}/${JAZZ_DISCORD_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

exec bun /app/packages/discord-bot/src/bridge.ts

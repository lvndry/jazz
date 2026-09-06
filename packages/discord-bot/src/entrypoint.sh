#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"
JAZZ_DISCORD_PROVIDER="${JAZZ_DISCORD_PROVIDER:-openai}"
JAZZ_DISCORD_MODEL="${JAZZ_DISCORD_MODEL:-gpt-5.4}"
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/packages/discord-bot/src/agent.discord.json"

# Two ways to run this, and they protect against different people.
#
#   As root, with per-conversation sandboxes (the default): each channel's
#   agent runs as its own uid under ${JAZZ_HOME}/chats, so one person in the
#   guild cannot read another's. Everything is readable to the group owning the
#   data directory — the operator — and to nobody else, which needs umask 027.
#
#   As an ordinary user (compose `user:`): one uid, one Jazz home, and the data
#   readable to that user alone. Right only when the allowlist is one person —
#   note that allowing a whole guild is not that, since every member of it gets
#   their own conversation.
if [ "$(id -u)" -ne 0 ] || [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  umask 077
else
  umask 027
fi

mkdir -p "${JAZZ_HOME}/agents"

if [ "$(id -u)" -ne 0 ] || [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  # One uid owns the lot, so the simplest mode is also the strongest one
  # available: nothing outside this user gets in at all.
  chmod 700 "${JAZZ_HOME}"
  mkdir -p "${JAZZ_HOME}/personas"
else
  # Per-conversation sandboxes live at ${JAZZ_HOME}/chats/dc_<channel id>, each
  # owned by its own uid. Those uids are deliberately not in the operator group,
  # so the two directories on the way to a sandbox have to stay traversable —
  # "enter a path you already know" (o+x) without "list what is here" (o+r).
  # What they hold is still unreadable: the bridge's own files are 0640 and each
  # sandbox is 2750.
  chmod 2751 "${JAZZ_HOME}"
  mkdir -p "${JAZZ_HOME}/chats" && chmod 2751 "${JAZZ_HOME}/chats"
  # Personas are the one thing every conversation is meant to see the same copy
  # of, and only the operator installs them.
  mkdir -p "${JAZZ_HOME}/personas" && chmod 755 "${JAZZ_HOME}/personas"
fi

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

if [ "$(id -u)" -ne 0 ]; then
  echo "Running as uid $(id -u): one Jazz home, ${JAZZ_HOME} is 0700, and only that user can read it. Per-conversation sandboxes need root and are off." >&2
elif [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  echo "JAZZ_BOT_CHAT_ISOLATION=0: per-conversation sandboxes are off, so every channel shares one Jazz home and one uid." >&2
else
  OPERATOR_GID="${JAZZ_BOT_OPERATOR_GID:-$(stat -c %g "${JAZZ_HOME}")}"
  echo "Per-conversation sandboxes on: each channel runs as its own uid under ${JAZZ_HOME}/chats, readable by group ${OPERATOR_GID} and nobody else." >&2
fi

exec bun /app/packages/discord-bot/src/bridge.ts

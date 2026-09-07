#!/bin/sh
set -eu

JAZZ_HOME="${JAZZ_HOME:-/data}"

# Two ways to run this, and they protect against different people.
#
#   As root, with per-chat sandboxes (the default): each chat's agent runs as
#   its own uid under ${JAZZ_HOME}/chats, so one allowlisted person's agent
#   cannot read another's. Everything is readable to the group owning the data
#   directory — the operator — and to nobody else, which needs umask 027.
#
#   As an ordinary user (compose `user:`): one uid, one Jazz home, and the data
#   readable to that user alone. There is nothing to sandbox from, because
#   every chat already runs as the person who owns the deployment. Right when
#   the allowlist is one person; umask 077, since no group needs in.
if [ "$(id -u)" -ne 0 ] || [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  umask 077
else
  umask 027
fi
JAZZ_TELEGRAM_PROVIDER="${JAZZ_TELEGRAM_PROVIDER:-openai}"
JAZZ_TELEGRAM_MODEL="${JAZZ_TELEGRAM_MODEL:-gpt-5.4}"
# Reasoning effort. Keep it in sync with the model: reasoning-capable models
# (gpt-5.4, qwen3, …) can use low|medium|high; models without it (mistral-small,
# gemma, …) 400 unless this is "disable".
JAZZ_REASONING="${JAZZ_REASONING:-medium}"
AGENT_TEMPLATE="/app/packages/telegram-bot/src/agent.telegram.json"

mkdir -p "${JAZZ_HOME}/agents"

if [ "$(id -u)" -ne 0 ] || [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  # One uid owns the lot, so the simplest mode is also the strongest one
  # available: nothing outside this user gets in at all.
  chmod 700 "${JAZZ_HOME}"
  mkdir -p "${JAZZ_HOME}/personas"

  # $JAZZ_HOME being 0700 already stops anyone else walking in, but files
  # written before the switch still carry world-readable modes of their own.
  # Strip them so the directory mode is not the only thing standing between
  # another account and this data.
  chmod -R go-rwx "${JAZZ_HOME}" 2>/dev/null || true
else
  # Per-chat sandboxes live at ${JAZZ_HOME}/chats/tg_<chat id>, each owned by
  # its own uid. Those uids are deliberately not in the operator group, so the
  # two directories on the way to a sandbox have to stay traversable — "enter a
  # path you already know" (o+x) without "list what is here" (o+r). What they
  # hold is still unreadable: the bridge's own files are 0640 and each sandbox
  # is 2750.
  chmod 2751 "${JAZZ_HOME}"
  mkdir -p "${JAZZ_HOME}/chats" && chmod 2751 "${JAZZ_HOME}/chats"
  # Personas are the one thing every chat is meant to see the same copy of, and
  # only the operator installs them.
  mkdir -p "${JAZZ_HOME}/personas" && chmod 755 "${JAZZ_HOME}/personas"

  # Anything already in the data directory predates isolation and kept whatever
  # modes a 022 umask gave it. $JAZZ_HOME has to stay traversable for a
  # conversation to reach its own sandbox, so those leftovers stay reachable
  # too — a world-readable run log or history file from before the switch is
  # still readable by every conversation. Personas are shared on purpose;
  # everything else here belongs to the operator.
  # `find` rather than a shell glob: caches land at $HOME/.bun and $HOME/.cache,
  # and "*" does not match a leading dot.
  find "${JAZZ_HOME}" -mindepth 1 -maxdepth 1 ! -name personas ! -name chats \
    -exec chmod -R o-rwx {} + 2>/dev/null || true
fi

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
bun /app/packages/bot-shared/src/write-bridge-config.ts "${JAZZ_HOME}/config.json"

# Seed / refresh the template agent that per-chat agents are cloned from.
sed -e "s#__JAZZ_PROVIDER__#${JAZZ_TELEGRAM_PROVIDER}#g" \
    -e "s#__JAZZ_MODEL__#${JAZZ_TELEGRAM_MODEL}#g" \
    -e "s#__JAZZ_REASONING__#${JAZZ_REASONING}#g" \
    "${AGENT_TEMPLATE}" > "${JAZZ_HOME}/agents/telegram.json"
echo "Seeded agent 'telegram' (model=${JAZZ_TELEGRAM_PROVIDER}/${JAZZ_TELEGRAM_MODEL}, reasoning=${JAZZ_REASONING}) into ${JAZZ_HOME}/agents"

if [ "$(id -u)" -ne 0 ]; then
  echo "Running as uid $(id -u): one Jazz home, ${JAZZ_HOME} is 0700, and only that user can read it. Per-chat sandboxes need root and are off." >&2
elif [ "${JAZZ_BOT_CHAT_ISOLATION:-1}" = "0" ]; then
  echo "JAZZ_BOT_CHAT_ISOLATION=0: per-chat sandboxes are off, so every chat shares one Jazz home and one uid." >&2
else
  OPERATOR_GID="${JAZZ_BOT_OPERATOR_GID:-$(stat -c %g "${JAZZ_HOME}")}"
  echo "Per-chat sandboxes on: each chat runs as its own uid under ${JAZZ_HOME}/chats, readable by group ${OPERATOR_GID} and nobody else." >&2
fi

exec bun /app/packages/telegram-bot/src/bridge.ts

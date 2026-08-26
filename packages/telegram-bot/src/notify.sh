#!/bin/sh
# Send one operational message to the bridge's own Telegram chat.
#
# Called by auto-update.sh so a failed or surprising deploy reaches a human
# instead of only a logfile. Reads the same .env the bridge runs on, and exits
# non-zero on any problem so the caller can note it without aborting.
set -eu

DIR=$(cd -- "$(dirname -- "$0")" && pwd)
MESSAGE=${1:?usage: notify.sh <message>}
ENV_FILE="${DIR}/.env"

[ -f "$ENV_FILE" ] || { echo "notify: no ${ENV_FILE}" >&2; exit 1; }

# Read the two keys directly rather than sourcing: .env holds secrets with
# characters a shell would happily interpret.
token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"' \r')
# The first allowed chat is the operator's; the bot cannot message anyone else.
chat=$(sed -n 's/^TELEGRAM_ALLOWED_CHAT_IDS=//p' "$ENV_FILE" | tail -1 |
  tr -d '"'"'"' \r' | cut -d, -f1)

[ -n "$token" ] || { echo "notify: TELEGRAM_BOT_TOKEN not set" >&2; exit 1; }
[ -n "$chat" ] || { echo "notify: TELEGRAM_ALLOWED_CHAT_IDS not set" >&2; exit 1; }

# --data-urlencode keeps newlines and any markup in the message intact, and no
# parse_mode is sent so nothing in it can be read as broken formatting.
curl -sS -o /dev/null -m 20 -X POST \
  "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat}" \
  --data-urlencode "text=🛠 ${MESSAGE}" \
  --data-urlencode "disable_notification=false"

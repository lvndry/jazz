#!/bin/sh
# Send one operational message to the bridge's own Discord channel.
#
# Called by auto-update.sh so a failed or surprising deploy reaches a human
# instead of only a logfile. Needs DISCORD_ALLOWED_CHANNEL_IDS: a bot can post
# to a channel without the extra DM-open round trip a user id would need.
set -eu

DIR=$(cd -- "$(dirname -- "$0")" && pwd)
MESSAGE=${1:?usage: notify.sh <message>}
ENV_FILE="${DIR}/.env"

[ -f "$ENV_FILE" ] || { echo "notify: no ${ENV_FILE}" >&2; exit 1; }

token=$(sed -n 's/^DISCORD_BOT_TOKEN=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"' \r')
channel=$(sed -n 's/^DISCORD_ALLOWED_CHANNEL_IDS=//p' "$ENV_FILE" | tail -1 |
  tr -d '"'"'"' \r' | cut -d, -f1)

[ -n "$token" ] || { echo "notify: DISCORD_BOT_TOKEN not set" >&2; exit 1; }
[ -n "$channel" ] || { echo "notify: DISCORD_ALLOWED_CHANNEL_IDS not set" >&2; exit 1; }

# jq is not a given on a deploy box, so build the one JSON string by hand:
# escape backslashes, quotes and newlines, which is all this payload can contain.
escaped=$(printf '%s' "🛠 ${MESSAGE}" |
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print sep $0; sep="\\n"}')

curl -sS -o /dev/null -m 20 -X POST \
  "https://discord.com/api/v10/channels/${channel}/messages" \
  -H "Authorization: Bot ${token}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: DiscordBot (https://github.com/lvndry/jazz, 1.0)" \
  -d "{\"content\":\"${escaped}\"}"

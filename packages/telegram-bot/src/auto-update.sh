#!/bin/sh
# Nightly auto-update for the Jazz Telegram bridge. The logic is shared with the
# other bridges; this only names which one. Install (as the deploy user):
#
#   (crontab -l 2>/dev/null; echo "30 4 * * * $HOME/jazz/packages/telegram-bot/src/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
#
# Paths are derived from the script's own location, so it works wherever the
# repo lives.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/../../bot-shared/src/auto-update.sh" "$DIR" jazz-telegram

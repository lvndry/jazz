#!/bin/sh
# Nightly auto-update for the Jazz Telegram bridge.
#
# Fast-forwards the checkout to the latest origin/main, rebuilds only if it
# actually changed, and rolls back to the previous commit if the new build
# doesn't come up healthy. Safe to run from cron. Install (as the deploy user):
#
#   (crontab -l 2>/dev/null; echo "30 4 * * * $HOME/jazz/integrations/telegram-bot/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
#
# Paths are derived from the script's own location, so it works wherever the
# repo lives.
set -eu

PATH=/usr/local/bin:/usr/bin:/bin
export PATH

DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO=$(cd -- "$DIR/../.." && pwd)
PROJECT=jazz-telegram
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cd "$REPO"
git fetch -q origin main
PREV=$(git rev-parse HEAD)
LATEST=$(git rev-parse origin/main)

if [ "$PREV" = "$LATEST" ]; then
  echo "$STAMP up-to-date ($PREV)"
  exit 0
fi

echo "$STAMP updating ${PREV} -> ${LATEST}"
# Fast-forward only: never silently discard local commits/divergence.
git merge --ff-only origin/main

cd "$DIR"
docker compose -p "$PROJECT" up -d --build

# Health gate — give it up to a minute to report healthy.
attempt=0
while [ "$attempt" -lt 12 ]; do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT" 2>/dev/null || echo none)
  if [ "$status" = "healthy" ]; then
    echo "$STAMP updated to ${LATEST} (healthy)"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done

echo "$STAMP update to ${LATEST} did not become healthy — rolling back to ${PREV}"
cd "$REPO"
git reset --hard "$PREV"
cd "$DIR"
docker compose -p "$PROJECT" up -d --build
exit 1

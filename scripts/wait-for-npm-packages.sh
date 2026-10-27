#!/bin/sh
# Waits until the npm registry serves each given package version to installs.
#
# Usage: scripts/wait-for-npm-packages.sh <name@version>...
#
# npm publish returns minutes before the registry serves a large package, and jazz-ai installed
# in that window gets no binary for that platform, so Release Binaries runs this between
# publishing the platform packages and publishing jazz-ai. It reads the abbreviated document
# npm install reads, which can lag behind the full one npm view reads. It gives up after
# WAIT_SECONDS (default 1800), polling every POLL_SECONDS (default 15).
set -eu

[ "$#" -gt 0 ] || { echo "usage: wait-for-npm-packages.sh <name@version>..." >&2; exit 2; }
registry=${NPM_REGISTRY:-https://registry.npmjs.org}
poll_seconds=${POLL_SECONDS:-15}
deadline=$(( $(date +%s) + ${WAIT_SECONDS:-1800} ))

for package in "$@"; do
  name=${package%@*}
  version=${package##*@}
  until curl -fsS --connect-timeout 10 --max-time 30 \
    -H "Accept: application/vnd.npm.install-v1+json" "$registry/$name" 2>/dev/null \
    | jq -e --arg version "$version" '.versions[$version]' >/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$name@$version is still not served by $registry; giving up" >&2
      exit 1
    fi
    sleep "$poll_seconds"
  done
  echo "$name@$version is served"
done

#!/bin/sh
# Role-based entrypoint for the cross-network peer-invite demo. See docker-compose.yml for
# how alice/bob/caddy are wired: alice and bob sit on two Docker networks with no route
# between them, and can only reach each other through the caddy container, which is attached
# to both — the same "daemon on loopback behind a reverse proxy" shape
# docs/guide/peers-setup.md's "over the internet" section describes, minus real TLS (that
# needs a real domain to get a certificate for, which a local demo doesn't have).
set -eu

# Re-exec under a private D-Bus session the first time through, so every command below —
# including the daemon this script backgrounds, which later has to handle an accept request
# that writes to the keyring — inherits a real Secret Service to talk to. Without this,
# detectKeyringBackend() (packages/adapters/src/secrets/keyring.ts) finds "none" and invite
# acceptance correctly, deliberately refuses rather than losing the resulting token.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0" "$@"
fi

# Unlocks (creating, on first run) the default gnome-keyring collection with an empty
# passphrase — fine for a throwaway demo container that gets torn down with `docker compose
# down -v`, not a pattern to reuse anywhere secrets need to survive or matter beyond one run.
eval "$(printf '\n' | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL

cd /app

if [ ! -d node_modules/effect ]; then
  echo "Installing dependencies (first run only, cached in a named volume after this)..."
  bun install
fi

export JAZZ_HOME=/data
INVITE_FILE=/shared/invite.json

case "$ROLE" in
  bob)
    echo "== bob: provisioning agent =="
    bun run scripts/provision-agent.ts bob

    echo "== bob: starting daemon (0.0.0.0 inside this container's own network namespace" \
      "only — nothing outside this compose project can reach it) =="
    bun run packages/runtime/src/main.ts daemon --serve-peers bob --host 0.0.0.0 --port 4747 &

    echo "== bob: waiting for the daemon to actually answer =="
    i=0
    while [ "$i" -lt 40 ]; do
      if bun -e 'process.exit((await fetch("http://127.0.0.1:4747/health").catch(() => undefined))?.ok ? 0 : 1)'; then
        break
      fi
      i=$((i + 1))
      sleep 0.25
    done

    echo "== bob: inviting alice, advertising the caddy hostname as the public endpoint =="
    # Write-then-rename rather than a direct redirect: alice polls for this file's existence,
    # and a plain ">" creates the (empty) file before its content is written, which is a real
    # race — she can see it exist and read a truncated JSON before bob has finished writing.
    bun run packages/runtime/src/main.ts peers invite create alice \
      --as bob \
      --public-url http://caddy \
      --may about-me \
      --expires 1h \
      --json > "$INVITE_FILE.tmp"
    mv "$INVITE_FILE.tmp" "$INVITE_FILE"
    cat "$INVITE_FILE"

    echo "== bob: daemon staying up for alice to reach =="
    wait
    ;;

  alice)
    echo "== alice: provisioning agent =="
    bun run scripts/provision-agent.ts alice ask_peer

    echo "== alice: waiting for bob's invite (through caddy, not directly — alice has no" \
      "route to bob's network at all) =="
    i=0
    while [ ! -f "$INVITE_FILE" ]; do
      i=$((i + 1))
      if [ "$i" -gt 60 ]; then
        echo "Timed out waiting for bob's invite." >&2
        exit 1
      fi
      sleep 1
    done

    INVITE_URL=$(bun -e 'const data = JSON.parse(await Bun.file("/shared/invite.json").text()); console.log(data.url);')
    echo "Invite URL (resolves to the caddy container, not bob's daemon directly): $INVITE_URL"

    echo "== alice: accepting =="
    bun run packages/runtime/src/main.ts peers invite accept "$INVITE_URL" --yes

    echo "== alice: asking bob's agent a real question, over a route that never touches" \
      "bob's network directly =="
    bun run packages/runtime/src/main.ts run --agent alice \
      "ask bob's agent what time it is on his machine"

    echo "== alice: her side of the ledger =="
    bun run packages/runtime/src/main.ts peers log
    ;;

  *)
    echo "Set ROLE=bob or ROLE=alice." >&2
    exit 1
    ;;
esac

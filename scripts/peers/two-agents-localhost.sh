#!/usr/bin/env bash
#
# Two jazz agents on one machine, becoming peers by invite instead of by hand, then actually
# asking each other something and getting a real, model-generated answer back.
#
# This is the part `packages/adapters/src/daemon/peer-invite-flow.test.ts` cannot cover: that
# test proves the invite/redeem/authorize plumbing with fakes standing in for a real agent
# stack, deliberately, because a real answer needs a real LLM and a real keyring — neither of
# which belongs in an automated, deterministic CI run. This script is the other half: run it
# to see the whole feature actually work, end to end, fully unattended.
#
# `jazz agent create` is an Ink TUI wizard with no CLI flags — true of the product today,
# independent of this feature (docs/guide/creating-agents.md: "if you want to script agent
# creation, write the JSON file directly"). `scripts/peers/provision-agent.ts` does exactly
# that, so this script never has to pause for a human.
#
# Usage:
#   ./scripts/peers/two-agents-localhost.sh
#
# Uses OpenRouter's free-tier `qwen3-next-80b-a3b-instruct:free` model for both agents. Needs
# an OpenRouter key to actually answer — `OPENROUTER_API_KEY` if set, otherwise whatever
# `llm.openrouter.api_key` is already in this machine's OS keyring. That lookup is by a fixed
# account name, not scoped to `$JAZZ_HOME`, so an OpenRouter key already configured for your
# regular jazz setup covers Alice's and Bob's separate temp homes here too — nothing to export
# if you already use OpenRouter with jazz. Otherwise get a free key at https://openrouter.ai
# (no credit card, but still an account) and either export it or `jazz config set
# llm.openrouter.api_key <key>` once.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ALICE_HOME="$(mktemp -d -t jazz-alice-XXXXXX)"
BOB_HOME="$(mktemp -d -t jazz-bob-XXXXXX)"
# Randomized rather than a fixed port: a prior run of this same script that didn't exit
# cleanly (killed terminal, Ctrl-C that skipped the trap) can leave a daemon still bound to a
# fixed port, and every subsequent run would then fail with "port in use" until someone found
# and killed it by hand.
BOB_PORT=$((30000 + RANDOM % 10000))
DAEMON_PID=""

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  # Belt-and-suspenders: if the PID-based kill above missed anything — a grandchild the
  # shell's `$!` didn't capture, or this trap running after the process tree already got
  # rearranged — nothing should still be answering on the port this run picked. This is what
  # actually stops the port from being held forever across runs; the PID kill alone wasn't
  # doing that reliably.
  if command -v lsof >/dev/null 2>&1; then
    local stray
    stray="$(lsof -ti "tcp:$BOB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$stray" ]]; then
      echo "Cleaning up a leftover process still bound to port $BOB_PORT (pid $stray)." >&2
      kill $stray 2>/dev/null || true
    fi
  fi
  # Removing the daemon's own data directory while it is still exiting is a real race (its
  # graceful shutdown still touches files under here) — wait for it to actually be gone, not
  # just signaled, before deleting out from under it.
  for _ in $(seq 1 20); do
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 0.1
  done
  rm -rf "$ALICE_HOME" "$BOB_HOME" 2>/dev/null || true
}
# EXIT alone covers a normal Ctrl-C in an interactive terminal (SIGINT to the whole
# foreground process group already reaches the backgrounded daemon too, since this script
# never puts it in its own process group) — INT/TERM/HUP are named explicitly anyway so
# cleanup is not depending on that detail of job control. Nothing traps SIGKILL; a `kill -9`
# of this script is the one case the port-based fallback above exists for.
trap cleanup EXIT INT TERM HUP

jazz() {
  bun run "$ROOT_DIR/packages/runtime/src/main.ts" "$@"
}

echo "== Step 1: create the two agents, non-interactively =="
echo "Alice's home: $ALICE_HOME"
JAZZ_HOME="$ALICE_HOME" bun run "$ROOT_DIR/scripts/peers/provision-agent.ts" alice ask_peer
echo "Bob's home:   $BOB_HOME"
JAZZ_HOME="$BOB_HOME" bun run "$ROOT_DIR/scripts/peers/provision-agent.ts" bob

echo
echo "== Step 2: bob starts serving on port $BOB_PORT (grants nothing yet) =="
# Not routed through the `jazz()` wrapper: backgrounding a shell *function* call captures, in
# `$!`, the PID of the subshell running that function — not necessarily the actual `bun`
# process it invokes, which is what ends up bound to the port. Calling `bun run` directly
# keeps `$!` and "whatever lsof finds on this port" the same PID, which cleanup below depends
# on.
bun run "$ROOT_DIR/packages/runtime/src/main.ts" --data-dir "$BOB_HOME" daemon --serve-peers bob --port "$BOB_PORT" &
DAEMON_PID=$!

for _ in $(seq 1 20); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Bob's daemon exited before it started serving — see the error above." >&2
    exit 1
  fi
  if curl -sf "http://127.0.0.1:$BOB_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:$BOB_PORT/health" >/dev/null 2>&1; then
  echo "Bob's daemon never became reachable on port $BOB_PORT." >&2
  exit 1
fi

echo
echo "== Step 3: bob invites alice — this is the whole feature =="
CREATE_OUTPUT="$(jazz --data-dir "$BOB_HOME" peers invite create alice --as bob --port "$BOB_PORT" --may about-me --expires 1h --json)"
echo "$CREATE_OUTPUT"
INVITE_URL="$(echo "$CREATE_OUTPUT" | bun -e 'const data = JSON.parse(await Bun.stdin.text()); console.log(data.url);')"

echo
echo "== Step 4: alice accepts the link — no openssl, no set-token, no config edit =="
jazz --data-dir "$ALICE_HOME" peers invite accept "$INVITE_URL" --yes

echo
echo "== Step 5: alice asks bob's agent a question, and gets a real answer back =="
jazz --data-dir "$ALICE_HOME" run --agent alice "ask bob's agent what time it is on his machine"

echo
echo "== The ledger on both sides =="
echo "--- bob (was asked) ---"
jazz --data-dir "$BOB_HOME" peers log
echo "--- alice (asked) ---"
jazz --data-dir "$ALICE_HOME" peers log

echo
echo "Done. The only shared secret either human ever saw was the invite link itself."

#!/bin/sh
# Write ~/Library/LaunchAgents/ai.lysk.jazz.imessage.plist from the template,
# with every path resolved to an absolute one.
#
# Deliberately does not load the agent. Full Disk Access has to be granted to
# the bun binary first, and an agent loaded before that just crash-loops writing
# the same permission error into its log. The next steps are printed instead.
#
# Usage: ./install-launchagent.sh [allowed-handles]
#   allowed-handles: comma-separated phone numbers (E.164) or Apple IDs.
#                    Optional — the self trigger alone is enough to test with.

set -eu

LABEL="ai.lysk.jazz.imessage"
TEMPLATE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "${TEMPLATE_DIR}/../.." && pwd)
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ALLOWED_HANDLES="${1:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is not on PATH. $2" >&2
    exit 1
  }
  command -v "$1"
}

BUN=$(require bun "Install it from https://bun.sh")
JAZZ=$(require jazz "Install Jazz first.")
# imsg is the one thing the bridge can install for itself, so a missing one is
# not fatal here — the first interactive run offers to fetch it.
IMSG=$(command -v imsg 2>/dev/null || echo "/opt/homebrew/bin/imsg")

JAZZ_HOME="${JAZZ_HOME:-${HOME}/.jazz-imessage}"
mkdir -p "${JAZZ_HOME}" "${HOME}/Library/LaunchAgents"

if [ -e "${TARGET}" ]; then
  echo "error: ${TARGET} already exists. Remove it first, or edit it by hand." >&2
  exit 1
fi

sed \
  -e "s|__BUN__|${BUN}|g" \
  -e "s|__REPO__|${REPO}|g" \
  -e "s|__JAZZ__|${JAZZ}|g" \
  -e "s|__IMSG__|${IMSG}|g" \
  -e "s|__JAZZ_HOME__|${JAZZ_HOME}|g" \
  -e "s|__ALLOWED_HANDLES__|${ALLOWED_HANDLES}|g" \
  "${TEMPLATE_DIR}/${LABEL}.plist" > "${TARGET}"

# The plist holds an allow-list and the paths of everything the agent can run.
chmod 600 "${TARGET}"

echo "Wrote ${TARGET}"
echo
echo "Next, in order:"
echo
echo "  1. Grant Full Disk Access to the bun binary itself:"
echo "     System Settings → Privacy & Security → Full Disk Access → +"
echo "     Press Cmd-Shift-G and enter: ${BUN}"
echo
echo "     This is why the agent runs under launchd: bun is the process macOS"
echo "     attributes the access to, so the grant covers this bridge instead of"
echo "     every command you type into a terminal."
echo
echo "  2. Start it:"
echo "     launchctl bootstrap gui/\$(id -u) ${TARGET}"
echo
echo "  3. Watch it come up:"
echo "     tail -f ${JAZZ_HOME}/bridge.log"
echo
echo "     Expect: 'iMessage bridge ready.' Then text yourself 'jazz hello'."
echo "     The first send raises the Automation → Messages prompt once; allow it."
echo
echo "  To stop:    launchctl bootout gui/\$(id -u)/${LABEL}"
echo "  To restart: launchctl kickstart -k gui/\$(id -u)/${LABEL}"

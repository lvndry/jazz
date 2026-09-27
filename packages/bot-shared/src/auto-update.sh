#!/bin/sh
# Hourly auto-update for a Jazz chat bridge, shared by every bridge.
#
# By default the checkout follows releases: it moves to the newest release tag
# (vX.Y.Z) once one is published past the running commit, rebuilds only if it
# actually changed, and rolls back to the previous commit if the new build does
# not come up healthy. It never moves backwards, so a checkout that is already
# ahead of the newest release waits for the next one.
#
# Set JAZZ_DEPLOY_BRANCH=<branch> to follow a branch instead (fast-forwarding
# to origin/<branch> on every run), for example main to run every merged commit.
#
# Usage (from a bridge's own auto-update.sh):
#   exec "$DIR/../../bot-shared/src/auto-update.sh" "$DIR" jazz-telegram
#
# A bridge may sit next to an executable `notify.sh` taking one message
# argument; it is called on every outcome a human needs to see. Failure to
# notify never fails the update.
set -eu

# Cron runs with a minimal PATH, so name the standard locations first — but keep
# whatever was inherited on the end, or a docker installed outside them
# (rootless, snap, Homebrew) is invisible to an otherwise working deploy.
PATH=/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}
export PATH

BRIDGE_DIR=${1:?usage: auto-update.sh <bridge-dir> <compose-project>}
PROJECT=${2:?usage: auto-update.sh <bridge-dir> <compose-project>}
REPO=$(cd -- "$BRIDGE_DIR/../../.." && pwd)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEPLOY_BRANCH=${JAZZ_DEPLOY_BRANCH:-}
# Release tags are vMAJOR.MINOR.PATCH; plugin-sdk-v* and other tags are not deploys.
RELEASE_TAG_PATTERN='v[0-9]*.[0-9]*.[0-9]*'

# Cron has no reader. Anything a human must act on goes to the bridge itself: in a
# logfile, a failed run is indistinguishable from an update that was not needed.
notify() {
  echo "$STAMP $1"
  if [ -x "$BRIDGE_DIR/notify.sh" ]; then
    "$BRIDGE_DIR/notify.sh" "$1" || echo "$STAMP (notify failed)"
  fi
}

die() {
  notify "$1"
  exit 1
}

cd "$REPO"

# Stash tracked modifications before moving the checkout, rather than attempting
# a merge that cannot succeed. Only tracked modifications are stashed: untracked
# files are deliberate local config (a docker-compose.override.yml publishing a
# port, a .env) and stashing them would silently change how the bridge deploys.
# Nothing is discarded: the stash is left for a human and reported.
stash_local_edits() {
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git stash push -m "auto-update ${STAMP} (was on $1)" >/dev/null
    echo "Local edits were stashed. Recover with: git -C ${REPO} stash list"
  fi
}

# Commits reachable from $1 that neither $2 nor any remote branch has: moving the
# checkout off them does not delete them, but hides them from anyone looking at
# the deploy, so every move names them.
unpushed_commits() {
  git log --oneline "$1" --not "$2" --remotes 2>/dev/null || true
}

if [ -z "$DEPLOY_BRANCH" ]; then
  git fetch -q --tags origin
  RELEASE_TAG=$(git tag -l "$RELEASE_TAG_PATTERN" --sort=-v:refname | head -n 1)
  [ -n "$RELEASE_TAG" ] || die "auto-update: origin has no release tag matching ${RELEASE_TAG_PATTERN}; nothing to deploy"
  PREV=$(git rev-parse HEAD)
  LATEST=$(git rev-parse "${RELEASE_TAG}^{commit}")

  # Already on the release, or ahead of it (a checkout that used to follow main):
  # moving would be a downgrade, so wait for the next release instead.
  if git merge-base --is-ancestor "$LATEST" "$PREV"; then
    echo "$STAMP up-to-date ($PREV, at or past ${RELEASE_TAG})"
    exit 0
  fi

  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  message="auto-update: moving the checkout from ${CURRENT} (${PREV}) to release ${RELEASE_TAG}"
  orphans=$(unpushed_commits "$PREV" "$LATEST")
  if [ -n "$orphans" ]; then
    message="${message}
Commits only on this box (push them or they stay only here):
${orphans}"
  fi
  stashed=$(stash_local_edits "$CURRENT")
  if [ -n "$stashed" ]; then
    message="${message}
${stashed}"
  fi
  if [ -n "$orphans" ] || [ -n "$stashed" ]; then
    notify "$message"
  fi

  echo "$STAMP updating ${PREV} -> ${RELEASE_TAG} (${LATEST})"
  git checkout -q --detach "$RELEASE_TAG" ||
    die "auto-update: cannot check out ${RELEASE_TAG}; the bridge is still on ${PREV}"
else
  # Park the checkout back on the deploy branch before fast-forwarding it.
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$CURRENT_BRANCH" != "$DEPLOY_BRANCH" ]; then
    # Resolve to a sha before moving: on a detached HEAD there is no branch name
    # to diff against afterwards, and those commits are the easiest to lose.
    PRIOR_HEAD=$(git rev-parse HEAD)
    stashed=$(stash_local_edits "$CURRENT_BRANCH")
    git checkout -q "$DEPLOY_BRANCH" ||
      die "auto-update: cannot check out ${DEPLOY_BRANCH} from ${CURRENT_BRANCH}; left as-is"

    message="auto-update: moved the checkout from ${CURRENT_BRANCH} to ${DEPLOY_BRANCH}"
    orphans=$(unpushed_commits "$PRIOR_HEAD" "$DEPLOY_BRANCH")
    if [ -n "$orphans" ]; then
      message="${message}
Commits left behind on ${CURRENT_BRANCH} (push them or they stay only on this box):
${orphans}"
    fi
    if [ -n "$stashed" ]; then
      message="${message}
${stashed}"
    fi
    notify "$message"
  fi

  git fetch -q origin "$DEPLOY_BRANCH"
  PREV=$(git rev-parse HEAD)
  LATEST=$(git rev-parse "origin/${DEPLOY_BRANCH}")

  if [ "$PREV" = "$LATEST" ]; then
    echo "$STAMP up-to-date ($PREV)"
    exit 0
  fi

  echo "$STAMP updating ${PREV} -> ${LATEST}"
  # Fast-forward only: never silently discard local commits. Reaching here with a
  # non-fast-forwardable branch means someone committed to the deploy branch on
  # this box, which a cron job must not resolve on their behalf.
  git merge --ff-only "origin/${DEPLOY_BRANCH}" 2>/dev/null ||
    die "auto-update: ${DEPLOY_BRANCH} has local commits that block a fast-forward to ${LATEST}. Push or drop them; the bridge is still on ${PREV}."
fi

deploy() {
  cd "$BRIDGE_DIR"
  docker compose -p "$PROJECT" up -d --build
}

# Put the checkout and the running container back on the commit that worked.
# Reached from two different failures, so it must not assume the new build even
# started: `up -d` on the old tree is what actually restores service.
rollback() {
  cd "$REPO"
  git reset --hard "$PREV"
  deploy || notify "auto-update: rollback to ${PREV} also failed to start — the bridge is DOWN"
}

# Without this, `set -e` would abort with the checkout already fast-forwarded to a
# commit that never deployed. A failed build gets the same treatment as a failed
# health check.
if ! deploy; then
  notify "auto-update: build/start of ${LATEST} failed — rolling back to ${PREV}"
  rollback
  die "auto-update: rolled back to ${PREV}; ${LATEST} does not build and needs a look"
fi

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

notify "auto-update: ${LATEST} did not become healthy — rolling back to ${PREV}"
rollback
die "auto-update: rolled back to ${PREV}; ${LATEST} is unhealthy and needs a look"

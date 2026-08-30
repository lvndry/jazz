FROM oven/bun:1

# A headless Secret Service (gnome-keyring over a private D-Bus session) so
# `detectKeyringBackend()` (packages/adapters/src/secrets/keyring.ts) finds a real "libsecret"
# backend instead of "none" inside this container — without it, invite acceptance correctly
# refuses rather than losing the token (see entrypoint.sh's dbus-run-session wrapper for how
# this gets started and unlocked).
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    gnome-keyring \
    libsecret-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

#!/usr/bin/env bash
#
# Jazz installer.
#
#   curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
#
# Environment variables:
#   JAZZ_INSTALL_DIR   Directory to install into (default: $HOME/.local/bin)
#   JAZZ_VERSION       Version to install, e.g. v0.13.12 (default: latest)

set -euo pipefail

REPO="lvndry/jazz"
INSTALL_DIR="${JAZZ_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${JAZZ_VERSION:-latest}"

# Global so the EXIT trap can still see it once main() has returned and its
# locals are gone.
tmp=""
trap 'rm -rf "$tmp"' EXIT

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

info() { printf '%s\n' "$1"; }
success() { printf '%s%s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$1" "$RESET"; }
fail() {
  printf '%s%s%s\n' "$RED" "$1" "$RESET" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "This installer needs '$1', which is not on your PATH."
}

# Picks the release asset for this machine.
#
# Bun's glibc binaries do not run on musl systems, so Alpine and friends get
# their own asset; the loader in /lib is what distinguishes them.
detect_asset() {
  local os arch libc=""
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "Unsupported architecture: $arch. Install from npm instead: npm install -g jazz-ai" ;;
  esac

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)
      os="linux"
      if [ -f /lib/ld-musl-x86_64.so.1 ] || [ -f /lib/ld-musl-aarch64.so.1 ] || [ -f /etc/alpine-release ]; then
        libc="-musl"
      fi
      ;;
    *) fail "Unsupported operating system: $os. Install from npm instead: npm install -g jazz-ai" ;;
  esac

  printf 'jazz-%s-%s%s' "$os" "$arch" "$libc"
}

# Verifies a downloaded file against the release SHA256SUMS.
#
# An installer that pipes a remote file straight into a directory on PATH has to
# check what it got, and a missing checksum is treated as failure rather than
# skipped: a release without one is a broken release, not an unverifiable file.
verify_checksum() {
  local file="$1" name="$2" sums="$3" expected actual

  expected="$(awk -v target="$name" '$2 == target || $2 == "*" target { print $1 }' "$sums" | head -n 1)"
  [ -n "$expected" ] || fail "Release has no checksum for $name — refusing to install."

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    fail "This installer needs 'sha256sum' or 'shasum' to verify the download."
  fi

  [ "$expected" = "$actual" ] || fail "Checksum mismatch for $name — refusing to install."
}

main() {
  require curl
  require gzip
  require uname

  local asset base
  asset="$(detect_asset)"

  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$VERSION"
  fi

  tmp="$(mktemp -d)"

  info "Downloading ${BOLD}${asset}${RESET} (${VERSION})..."
  curl -fsSL --retry 3 -o "$tmp/$asset.gz" "$base/$asset.gz" ||
    fail "Could not download $base/$asset.gz"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "Could not download $base/SHA256SUMS"

  verify_checksum "$tmp/$asset.gz" "$asset.gz" "$tmp/SHA256SUMS"

  gzip -dc "$tmp/$asset.gz" >"$tmp/jazz" || fail "Could not decompress $asset.gz"
  chmod 755 "$tmp/jazz"

  mkdir -p "$INSTALL_DIR" || fail "Could not create $INSTALL_DIR"
  # Move into place rather than writing over the target: rename is atomic, and
  # it is the only way to replace a binary that is currently running.
  mv -f "$tmp/jazz" "$INSTALL_DIR/jazz" ||
    fail "Could not write to $INSTALL_DIR. Choose another directory with JAZZ_INSTALL_DIR."

  success "Jazz installed to $INSTALL_DIR/jazz"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      warn "$INSTALL_DIR is not on your PATH. Add it with:"
      info "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
      ;;
  esac

  info ""
  info "Run ${BOLD}jazz${RESET} to get started."
}

main "$@"

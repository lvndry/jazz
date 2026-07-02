#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
REPO="https://github.com/julienXX/terminal-notifier.git"
TAG="2.0.0"
VENDOR_DIR="$ROOT/vendor/terminal-notifier"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

git clone --depth 1 --branch "$TAG" "$REPO" "$BUILD_DIR"

build_arch() {
  local arch="$1"
  local output_dir="$2"

  rm -rf "$BUILD_DIR/build"
  xcodebuild \
    -arch "$arch" \
    -project "$BUILD_DIR/Terminal Notifier.xcodeproj" \
    -target terminal-notifier \
    SYMROOT=build \
    MACOSX_DEPLOYMENT_TARGET=10.13 \
    CODE_SIGN_IDENTITY= \
    -quiet

  rm -rf "$output_dir/terminal-notifier.app"
  mkdir -p "$output_dir"
  cp -R "$BUILD_DIR/build/Release/terminal-notifier.app" "$output_dir/"
}

build_arch arm64 "$VENDOR_DIR/arm64"
build_arch x86_64 "$VENDOR_DIR/x64"

echo "Built native terminal-notifier binaries:"
lipo -info "$VENDOR_DIR/arm64/terminal-notifier.app/Contents/MacOS/terminal-notifier"
lipo -info "$VENDOR_DIR/x64/terminal-notifier.app/Contents/MacOS/terminal-notifier"

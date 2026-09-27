#!/bin/sh
# Runs a compiled jazz binary far enough to prove it starts on this machine.
#
# Usage: scripts/smoke-binary.sh <binary> <expected-version>
#
# Checks that `--version` reports the expected version and that `persona list` reads the
# built-in personas out of the binary's embedded assets, each in a throwaway JAZZ_HOME.
# Release Binaries runs it on every shipped platform (inside Alpine for the musl builds).
set -eu

binary=${1:?usage: smoke-binary.sh <binary> <expected-version>}
expected=${2:?usage: smoke-binary.sh <binary> <expected-version>}
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

version=$(JAZZ_HOME="$home" "$binary" --version)
echo "$binary --version: $version"
case "$version" in
  *"$expected"*) ;;
  *)
    echo "$binary reports '$version', expected $expected" >&2
    exit 1
    ;;
esac

personas=$(JAZZ_HOME="$home" "$binary" persona list)
if ! printf '%s' "$personas" | grep -q "built-in"; then
  echo "$binary persona list did not list the built-in personas" >&2
  exit 1
fi
echo "$binary starts"

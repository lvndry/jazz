/**
 * @fileoverview Which binary a bridge spawns a run with.
 *
 * npm installs it as `bin/jazz`, but `build:binary` writes `jazz-darwin-arm64`
 * and the other target names beside it. Recognising only the first sent a
 * locally built bridge to a PATH lookup, and put a path from inside the bundle
 * into its service plist.
 */

import { basename } from "node:path";

export function isJazzBinaryPath(executablePath: string): boolean {
  const name = basename(executablePath);
  return name === "jazz" || name.startsWith("jazz-");
}

/** Whether this process is the Jazz binary rather than `bun`. */
export function runningAsJazzBinary(): boolean {
  return isJazzBinaryPath(process.execPath);
}

/**
 * When the bridge runs inside the Jazz binary, that binary is this process, and
 * naming it directly beats a PATH lookup that could resolve to a different
 * install. Under `bun bridge.ts` the executable is bun, which cannot run a Jazz
 * turn, so that case falls back to the name.
 */
export function defaultJazzBinary(): string {
  return runningAsJazzBinary() ? process.execPath : "jazz";
}

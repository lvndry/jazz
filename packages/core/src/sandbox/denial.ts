/**
 * @fileoverview Telling a confinement denial from an ordinary command failure.
 *
 * A confined write that is refused comes back as `EPERM` (macOS Seatbelt) or `EROFS` (Linux
 * bwrap's read-only bind): a line ending in `Operation not permitted` or `Read-only file
 * system`. That ending alone proves nothing, since a command can fail that way unconfined and a
 * confined child can print the line itself. `classifyWriteDenial` therefore needs three
 * independent facts before it says "denied":
 *
 * 1. the command exited non-zero,
 * 2. a stderr line ends, anchored, in one of the two error texts, and
 * 3. a path on that line canonicalizes to somewhere outside the policy's writable roots.
 *
 * The third is checked against the policy, not against the wording, so no message prefix is
 * trusted. A spoofed line can at worst offer the model an escalation that still waits on a
 * person's approval.
 */

import { canonicalizePath, isPathWritable, type WritePolicy } from "./write-policy";

/** The two errno texts a refused confined write prints, matched only at the end of a line. */
const DENIAL_LINE_ENDING = /: (?:Operation not permitted|Read-only file system)$/;

const QUOTED_PATH = /['"`‘“]([^'"`’”]+)['"`’”]/g;

export interface WriteDenial {
  /** Canonical path of the refused write. */
  readonly deniedPath: string;
}

function candidatePaths(line: string): string[] {
  const withoutEnding = line.replace(DENIAL_LINE_ENDING, "");
  const quoted = Array.from(withoutEnding.matchAll(QUOTED_PATH), (match) => match[1] ?? "");
  const parts = withoutEnding.split(": ");
  const segments = (parts.length > 1 ? parts.slice(1) : parts)
    .map((segment) => segment.trim())
    .flatMap((segment) => (/\s/.test(segment) ? [segment.split(/\s+/).pop() ?? ""] : [segment]))
    .filter((segment) => segment.length > 0);
  return [...quoted, ...segments].filter((candidate) => candidate.length > 0);
}

/**
 * The first refused write in `stderr`, or undefined when the failure is not a confinement
 * denial. `cwd` is where the command ran, for paths the shell printed relative.
 */
export function classifyWriteDenial(input: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly policy: WritePolicy;
  readonly cwd: string;
}): WriteDenial | undefined {
  if (input.exitCode === 0) {
    return undefined;
  }
  for (const rawLine of input.stderr.split("\n")) {
    const line = rawLine.trimEnd();
    if (!DENIAL_LINE_ENDING.test(line)) {
      continue;
    }
    for (const candidate of candidatePaths(line)) {
      if (!isPathWritable(input.policy, candidate, input.cwd)) {
        return { deniedPath: canonicalizePath(candidate, input.cwd) };
      }
    }
  }
  return undefined;
}

/**
 * Line-aligned redaction: the redacted form of a text, one entry per line of the original.
 *
 * Tools that number, slice, search or edit lines need the redacted view to keep the file's line
 * numbering. `redactSecretText` runs over the whole text, so a secret is recognized with all its
 * context (a private key block needs its END marker), and a block spanning several lines comes
 * back as one placeholder. Each original line of such a block shows that placeholder.
 */

import { diffArrays } from "diff";
import { redactSecretText, redactionPlaceholder, type KnownSecret } from "./redaction";

export interface RedactedLines {
  /** One entry per original line: the line itself, or its redacted form. */
  readonly lines: readonly string[];
  /** 0-based indexes of the original lines that hold a secret, in whole or in part. */
  readonly secretLineIndexes: ReadonlySet<number>;
}

/**
 * Longest run of original lines matched against one redacted line before falling back to a
 * line diff. A 4096-bit RSA private key block is about 50 lines.
 */
const MAX_COLLAPSED_LINES = 256;

/** `[redacted:`, as `redactionPlaceholder` writes it. */
const PLACEHOLDER_PREFIX = redactionPlaceholder("").slice(0, -1);

const PLACEHOLDER_PATTERN = new RegExp(
  `${PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\]\\n]*\\]`,
  "g",
);

/** What an original line inside a collapsed block shows: the block's placeholders. */
function blockRendering(redactedLine: string): string {
  const placeholders = [...new Set(redactedLine.match(PLACEHOLDER_PATTERN) ?? [])];
  return placeholders.length > 0 ? placeholders.join(" ") : redactionPlaceholder("secret");
}

/** Assign the redacted lines of one changed hunk to its original lines. */
function assignHunk(
  originalCount: number,
  redacted: readonly string[],
  firstIndex: number,
  into: { lines: string[]; secret: Set<number> },
): void {
  const rendering = blockRendering(redacted.join(" "));
  for (let offset = 0; offset < originalCount; offset++) {
    into.secret.add(firstIndex + offset);
    if (offset === originalCount - 1 && redacted.length > originalCount) {
      into.lines.push(redacted.slice(offset).join(" "));
    } else {
      into.lines.push(redacted[offset] ?? rendering);
    }
  }
}

function alignByDiff(
  original: readonly string[],
  redacted: readonly string[],
  firstIndex: number,
  into: { lines: string[]; secret: Set<number> },
): void {
  let index = firstIndex;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => {
    if (removed.length > 0) {
      assignHunk(removed.length, added, index, into);
      index += removed.length;
    }
    removed = [];
    added = [];
  };
  for (const change of diffArrays([...original], [...redacted])) {
    if (change.removed) {
      removed.push(...change.value);
    } else if (change.added) {
      added.push(...change.value);
    } else {
      flush();
      for (const line of change.value) {
        into.lines.push(line);
        index++;
      }
    }
  }
  flush();
}

/**
 * The redacted view of `originalLines`, as they were split from one text.
 *
 * Unchanged lines are compared directly. A changed line is matched to the longest run of original
 * lines that redacts to it on its own, which covers line-local secrets and whole private key
 * blocks (a key block's first line alone also redacts to the key placeholder);
 * anything else falls back to a line diff, which marks every original line it cannot pair.
 */
export function redactLines(
  originalLines: readonly string[],
  known: readonly KnownSecret[],
): RedactedLines {
  const original = originalLines.join("\n");
  const redactedText = redactSecretText(original, known);
  if (redactedText === original) {
    return { lines: originalLines, secretLineIndexes: new Set() };
  }
  const redacted = redactedText.split("\n");
  const into = { lines: [] as string[], secret: new Set<number>() };
  let originalIndex = 0;
  let redactedIndex = 0;
  while (originalIndex < originalLines.length && redactedIndex < redacted.length) {
    const line = originalLines[originalIndex] ?? "";
    const redactedLine = redacted[redactedIndex] ?? "";
    if (line === redactedLine) {
      into.lines.push(line);
      originalIndex++;
      redactedIndex++;
      continue;
    }
    let matchedCount = 0;
    const remainingRedacted = redacted.length - redactedIndex - 1;
    const longestRun = Math.min(
      MAX_COLLAPSED_LINES,
      originalLines.length - originalIndex - remainingRedacted,
    );
    for (let count = longestRun; count >= 1; count--) {
      const run = originalLines.slice(originalIndex, originalIndex + count).join("\n");
      if (redactSecretText(run, known) === redactedLine) {
        matchedCount = count;
        break;
      }
    }
    if (matchedCount === 0) {
      alignByDiff(
        originalLines.slice(originalIndex),
        redacted.slice(redactedIndex),
        originalIndex,
        into,
      );
      return { lines: into.lines, secretLineIndexes: into.secret };
    }
    assignHunk(matchedCount, [redactedLine], originalIndex, into);
    originalIndex += matchedCount;
    redactedIndex++;
  }
  if (originalIndex < originalLines.length) {
    assignHunk(originalLines.length - originalIndex, [], originalIndex, into);
  }
  return { lines: into.lines, secretLineIndexes: into.secret };
}

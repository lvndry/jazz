/**
 * Text files the user `@`-mentioned, inlined into the message they sent.
 *
 * Media files (`@shot.png`, `@report.pdf`) become attachments further down, in
 * `core/agent/user-input-attachments`. Everything else the `@` picker offers is
 * usually text (`@notes.md`, `@todo.txt`, `@config.yaml`), which no provider
 * takes as an attachment, so the chat reads it here and appends it to the
 * message in a `<file>` block the model can quote from. Only an explicit `@`
 * mention typed in the local terminal is read: a bare path in prose is not,
 * and remote surfaces never go through this.
 *
 * Use `inlineMentionedTextFiles(message, workingDirectory)` on the message the
 * user typed, before it is sent to the agent.
 */

import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { classifyAttachmentPath } from "@jazz/core/types/attachment";

/**
 * Largest text file inlined, in bytes. Big enough for notes, configs and a
 * long source file; a larger file is left to the agent's `read_file`, which
 * pages through it instead of spending the context window at once.
 */
export const MAX_INLINED_FILE_BYTES = 256 * 1024;

/** A NUL byte in the first bytes of a file marks it as binary. */
const BINARY_SNIFF_BYTES = 8192;

/** Mentions whose path could not be inlined, with the reason, for the user to see. */
export interface InlinedMentions {
  readonly message: string;
  readonly skipped: readonly string[];
}

/**
 * `@path`, `@"path with spaces"`, `@'path'` or `@path\ with\ escapes`, at the
 * start of the message or after whitespace, which is how the picker inserts
 * them (see `ui/at-mention.ts`).
 */
const MENTION_PATTERN = /(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^\s"'])+))/g;

function mentionedPaths(message: string): string[] {
  const paths: string[] = [];
  for (const match of message.matchAll(MENTION_PATTERN)) {
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) {
      paths.push(quoted);
      continue;
    }
    const bare = (match[3] ?? "").replace(/[.,;:!?)\]}]+$/, "").replace(/\\(.)/g, "$1");
    if (bare.length > 0) {
      paths.push(bare);
    }
  }
  return paths;
}

function absolutePathFor(path: string, workingDirectory: string): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Append the contents of every `@`-mentioned text file to the message.
 *
 * A mention that is not a file (a typo, a directory) is left as text. Media
 * files are left for the attachment path. A binary or oversized file is
 * reported in `skipped` so the user knows the model only saw its name.
 */
export async function inlineMentionedTextFiles(
  message: string,
  workingDirectory: string,
): Promise<InlinedMentions> {
  const blocks: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const path of mentionedPaths(message)) {
    if (classifyAttachmentPath(path) !== null) {
      continue;
    }
    const absolutePath = absolutePathFor(path, workingDirectory);
    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);

    const stats = await stat(absolutePath).catch(() => undefined);
    if (stats === undefined || !stats.isFile()) {
      continue;
    }
    if (stats.size > MAX_INLINED_FILE_BYTES) {
      skipped.push(
        `@${path} is larger than ${MAX_INLINED_FILE_BYTES / 1024} KiB, so only its path was sent.`,
      );
      continue;
    }
    if (await looksBinary(absolutePath)) {
      skipped.push(`@${path} is not a text file, so only its path was sent.`);
      continue;
    }
    const contents = await readFile(absolutePath, "utf-8");
    blocks.push(`<file path="${absolutePath}">\n${contents}\n</file>`);
  }

  return {
    message: blocks.length === 0 ? message : `${message}\n\n${blocks.join("\n\n")}`,
    skipped,
  };
}

/**
 * @fileoverview Finding media file paths in what the user typed
 *
 * Terminals do not hand a program the bytes of a pasted image — at best they insert a file
 * path. So path detection is not a lesser substitute for "real" attachment support; on a CLI it
 * *is* attachment support. It also means drag-and-drop works for free, since Warp, iTerm and
 * Ghostty all insert the dropped file's path at the cursor.
 *
 * Two forms are recognized: a bare path (`/Users/me/shot.png`, `./diagram.pdf`) and an
 * `@`-prefixed one (`@shot.png`), which mirrors how the rest of jazz references files.
 *
 * **Only genuine user input is scanned.** A path that appears in tool output must never become
 * an attachment on its own: that would let any file jazz reads talk the agent into uploading
 * arbitrary local files to a provider. Attachment is an action the user asks for, so it is
 * driven only by text the user wrote.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ATTACHMENT_MEDIA_TYPES,
  classifyAttachmentPath,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type MessageAttachment,
  rejectAttachmentReason,
} from "@/core/types/attachment";
import { probeMediaShape } from "@/core/utils/media-probe";

/**
 * Candidate spans in a line of user text, in three flavours.
 *
 * Filenames with spaces are the norm, not an edge case — macOS names every screenshot
 * "Screenshot 2026-08-18 at 16.12.12.png" — so matching only unbroken non-whitespace runs would
 * miss the single most common thing a Mac user attaches.
 *
 * The patterns overlap deliberately, and over-matching is safe: a candidate only becomes an
 * attachment if a file actually exists at that path. That existence check is what lets the
 * space-tolerant pattern be greedy without turning prose into surprise uploads.
 */
const PATH_CANDIDATE_PATTERNS: readonly RegExp[] = [
  // Quoted, the way a shell or a person quotes a path containing spaces.
  /['"]([^'"\n]+\.[A-Za-z0-9]{2,5})['"]/g,
  // An unbroken run, optionally @-prefixed, with shell-escaped spaces allowed. This is what
  // drag-and-drop inserts in most terminals.
  /@?(?:[^\s"']|\\ )+\.[A-Za-z0-9]{2,5}/g,
  // Anchored at something that looks like the start of a path, then lazily up to a *known*
  // media extension at a word boundary, so literal spaces in the middle survive.
  //
  // The extension list has to be explicit here. A generic `\.[A-Za-z0-9]{2,5}` matches lazily
  // and would stop at the first dot-ish run it finds: in
  // "Screenshot 2026-08-18 at 16.12.12.png" that is ".12", leaving a truncated path that fails
  // to resolve and never extends to ".png".
  new RegExp(
    `(?:~/|\\.{0,2}/)[^\\n"']*?\\.(?:${Object.keys(ATTACHMENT_MEDIA_TYPES).join("|")})(?=[\\s"'.,;:!?)\\]}]|$)`,
    "gi",
  ),
];

function collectCandidates(userInput: string): string[] {
  const candidates: string[] = [];
  for (const pattern of PATH_CANDIDATE_PATTERNS) {
    for (const match of userInput.matchAll(pattern)) {
      // The quoted pattern captures the inside; the others match the whole span.
      candidates.push(match[1] ?? match[0]);
    }
  }
  return candidates;
}

function stripDecoration(token: string): string {
  let candidate = token.startsWith("@") ? token.slice(1) : token;
  candidate = candidate.replace(/^["']|["']$/g, "");
  candidate = candidate.replace(/[.,;:!?)\]}]+$/g, "");
  // Undo shell-style escaping in one left-to-right pass: a backslash makes the next character
  // literal, whatever it is. Handling only "\\ " would mangle a filename that genuinely
  // contains a backslash — legal on POSIX — and doing it as two sequential replaces would turn
  // an escaped backslash followed by a space into the wrong thing.
  candidate = candidate.replace(/\\(.)/g, "$1");
  return candidate.trim();
}

export interface UserInputAttachments {
  /** Attachments successfully resolved from the input. */
  readonly attachments: ReadonlyArray<MessageAttachment>;
  /**
   * Human-readable problems worth surfacing — a path that matched a media extension but was
   * too large or unreadable. Silence here would be confusing: the user explicitly named a file.
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Resolve media attachments referenced by paths in `userInput`.
 *
 * Paths that do not exist are ignored rather than warned about, because ordinary prose contains
 * plenty of things that look like filenames ("update the v1.2 spec"). A path that exists *and*
 * has a media extension is taken as intentional.
 */
export async function collectUserInputAttachments(
  userInput: string,
  workingDirectory: string,
  isLocalProvider = false,
): Promise<UserInputAttachments> {
  const matches = collectCandidates(userInput);
  if (matches.length === 0) return { attachments: [], warnings: [] };

  const attachments: MessageAttachment[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();

  for (const rawToken of matches) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      warnings.push(
        `Only the first ${MAX_ATTACHMENTS_PER_MESSAGE} attachments were included; the rest were ignored.`,
      );
      break;
    }

    const candidate = stripDecoration(rawToken);
    const classified = classifyAttachmentPath(candidate);
    if (classified === null) continue;

    // `~` is what people type; nothing downstream expands it.
    const expanded = candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : candidate;
    const absolutePath = isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
    if (seenPaths.has(absolutePath)) continue;

    let byteSize: number;
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) continue;
      byteSize = stats.size;
    } catch {
      // Not a real file — almost certainly prose that happened to look like a path.
      continue;
    }
    seenPaths.add(absolutePath);

    const shape = await probeMediaShape(absolutePath, classified.kind);
    const attachment: MessageAttachment = {
      kind: classified.kind,
      mediaType: classified.mediaType,
      path: absolutePath,
      byteSize,
      ...shape,
    };

    const rejection = rejectAttachmentReason(attachment, isLocalProvider);
    if (rejection !== null) {
      warnings.push(rejection);
      continue;
    }
    attachments.push(attachment);
  }

  return { attachments, warnings };
}

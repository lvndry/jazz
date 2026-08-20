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
import { isAbsolute, resolve } from "node:path";
import {
  classifyAttachmentPath,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type MessageAttachment,
  rejectAttachmentReason,
} from "@/core/types/attachment";
import { probeMediaShape } from "@/core/utils/media-probe";

/**
 * Candidate path tokens in a line of user text.
 *
 * Matches an optional `@`, then a run of non-whitespace ending in a known media extension.
 * Quotes and trailing sentence punctuation are stripped by the caller — a user writing
 * "look at ./shot.png." means the file, not a file whose name ends in a period.
 */
const PATH_CANDIDATE = /@?(?:[^\s"']|\\ )+\.[A-Za-z0-9]{2,5}/g;

function stripDecoration(token: string): string {
  let candidate = token.startsWith("@") ? token.slice(1) : token;
  candidate = candidate.replace(/^["']|["']$/g, "");
  candidate = candidate.replace(/[.,;:!?)\]}]+$/g, "");
  // Shell-style escaped spaces survive drag-and-drop of a path with spaces in it.
  return candidate.replace(/\\ /g, " ");
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
  const matches = userInput.match(PATH_CANDIDATE);
  if (matches === null) return { attachments: [], warnings: [] };

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

    const absolutePath = isAbsolute(candidate) ? candidate : resolve(workingDirectory, candidate);
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

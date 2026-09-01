/**
 * @fileoverview Reducing an arbitrary id to something safe to use as one path segment.
 *
 * Every id Jazz stores under used to be machine-generated — `short.generate()`, or that with
 * a legible prefix — so joining one straight into a path was safe by construction. Threaded
 * webhook triggers break that assumption: the thread key comes from whoever calls the
 * webhook, and it lands in a conversation id, which becomes a directory name under
 * `work/` and a filename under `history/conversations/`. An unsanitized `../../..` there is
 * an arbitrary-path write from an authenticated caller.
 *
 * So this lives in core rather than beside any one writer: the rule is "no id becomes a path
 * segment without passing through here", and a rule enforced in only one of the three places
 * that build paths from ids is not a rule.
 */

import { createHash } from "node:crypto";

const MAX_ID_SEGMENT_CHARS = 64;
const ID_FINGERPRINT_CHARS = 8;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9_-]/g;

function fingerprint(value: string, chars: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, chars);
}

/**
 * Reduce an id to something safe in a path.
 *
 * Lossy on purpose for ids that are not already path-safe: the readable part is truncated
 * and a hash of the original appended, so two different ids can never collide on one file.
 * Because it is lossy, a path is never parsed back into ids — the header carries them.
 */
export function storageSafeSegment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unknown";
  if (SAFE_ID_PATTERN.test(trimmed) && trimmed.length <= MAX_ID_SEGMENT_CHARS) return trimmed;
  const readable = trimmed.replace(UNSAFE_ID_CHARACTERS, "-").slice(0, MAX_ID_SEGMENT_CHARS);
  return `${readable}-${fingerprint(trimmed, ID_FINGERPRINT_CHARS)}`;
}

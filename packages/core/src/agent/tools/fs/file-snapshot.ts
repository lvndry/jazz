/**
 * Bind a text-file read to the physical path and complete contents used by an edit.
 * The token is opaque to the model; `edit_file` compares it before showing an approval
 * and again while holding the file's edit lock before writing. A partial `read_file`
 * range still identifies the complete file, so changes outside the visible range
 * cannot silently shift line-number edits.
 */

import { createHash } from "node:crypto";

export function fileSnapshot(canonicalPath: string, content: string): string {
  const hash = createHash("sha256");
  hash.update(canonicalPath);
  hash.update("\0");
  hash.update(content);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Write private compaction comparison reports without following a destination symlink.
 * `saveReport` accepts JSON data and intentionally replaces regular report contents. It
 * validates the opened descriptor before changing permissions or truncating, and rejects
 * special files without waiting for a FIFO reader. Parent directories must already exist.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  writeFileSync,
} from "node:fs";

/** Reports contain conversation text and must remain owner-readable/writable only. */
export function saveReport(outputPath: string, report: unknown): void {
  const content = JSON.stringify(report, null, 2);
  const descriptor = openSync(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Compaction report destination must be a regular file");
    }
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

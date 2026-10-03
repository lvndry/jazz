/**
 * Points `$JAZZ_HOME` at a fresh temporary directory for the tests of one file, and puts the
 * real value back afterwards, so no test touches the developer's own Jazz state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "bun:test";

export function useTemporaryJazzHome(): { readonly directory: () => string } {
  let directory = "";
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env["JAZZ_HOME"];
    directory = mkdtempSync(path.join(tmpdir(), "jazz-computer-"));
    process.env["JAZZ_HOME"] = directory;
  });
  afterEach(() => {
    if (previous === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory: () => directory };
}

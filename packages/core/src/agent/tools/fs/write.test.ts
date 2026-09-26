import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

describe("write_file", () => {
  const directories: string[] = [];
  const write = createWriteFileTools();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const path = join(directory, "build", "diagrams", "timeline.svg");

    const execution = await runTool(write.execute, { path, content: "<svg/>" }, directory);

    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<svg/>");
  });
});

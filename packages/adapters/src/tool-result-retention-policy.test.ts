/** Cleanup defaults apply to absence, never to errors reading or validating destructive policy. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "bun:test";
import {
  readRetentionDaysFromFile,
  retentionDaysFromDocument,
} from "./tool-result-retention-policy";

test("requires a valid nonnegative retention setting", () => {
  expect(retentionDaysFromDocument({})).toBe(30);
  expect(retentionDaysFromDocument({ history: { toolResultRetentionDays: 0 } })).toBe(0);
  for (const value of [
    null,
    [],
    { history: null },
    { history: { toolResultRetentionDays: -1 } },
    { history: { toolResultRetentionDays: "0" } },
  ]) {
    expect(() => retentionDaysFromDocument(value)).toThrow();
  }
});

test("re-reads changes and refuses malformed or unreadable files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-retention-policy-"));
  const target = path.join(root, "config.json");
  try {
    expect(await readRetentionDaysFromFile(target)).toBe(30);
    await fs.writeFile(target, JSON.stringify({ history: { toolResultRetentionDays: 3 } }));
    expect(await readRetentionDaysFromFile(target)).toBe(3);
    await fs.writeFile(target, JSON.stringify({ history: { toolResultRetentionDays: 0 } }));
    expect(await readRetentionDaysFromFile(target)).toBe(0);
    await fs.writeFile(target, "{broken");
    await expect(readRetentionDaysFromFile(target)).rejects.toThrow("valid JSON");
    await fs.unlink(target);
    await fs.mkdir(target);
    await expect(readRetentionDaysFromFile(target)).rejects.toThrow("could not be read");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

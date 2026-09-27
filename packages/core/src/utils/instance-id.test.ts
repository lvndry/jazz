import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { getJazzInstanceId } from "./instance-id";

describe("getJazzInstanceId", () => {
  it("is one random id per Jazz home, stored so every process reads the same one", () => {
    const home = mkdtempSync(join(tmpdir(), "jazz-instance-"));
    const id = getJazzInstanceId(home);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(home, "instance-id"), "utf8").trim()).toBe(id);
    expect(getJazzInstanceId(home)).toBe(id);
  });

  it("differs between homes", () => {
    const first = getJazzInstanceId(mkdtempSync(join(tmpdir(), "jazz-instance-")));
    const second = getJazzInstanceId(mkdtempSync(join(tmpdir(), "jazz-instance-")));
    expect(first).not.toBe(second);
  });
});

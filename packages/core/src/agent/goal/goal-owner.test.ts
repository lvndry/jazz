import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { getGoalOwnerInstanceId } from "./goal-owner";

describe("getGoalOwnerInstanceId", () => {
  it("is one random id per Jazz home, stored so every process reads the same one", () => {
    const home = mkdtempSync(join(tmpdir(), "goal-owner-"));
    const id = getGoalOwnerInstanceId(home);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(home, "instance-id"), "utf8").trim()).toBe(id);
    expect(getGoalOwnerInstanceId(home)).toBe(id);
  });

  it("differs between homes", () => {
    const first = getGoalOwnerInstanceId(mkdtempSync(join(tmpdir(), "goal-owner-")));
    const second = getGoalOwnerInstanceId(mkdtempSync(join(tmpdir(), "goal-owner-")));
    expect(first).not.toBe(second);
  });
});

import { describe, expect, test } from "bun:test";
import { classifyLessonOutcome, outcomeRate } from "./outcomes";

describe("lesson outcomes", () => {
  test("distinguishes helped, failed, missed, and noop", () => {
    expect(classifyLessonOutcome({ recalled: true, triggerFired: false })).toBe("helped");
    expect(classifyLessonOutcome({ recalled: true, triggerFired: true })).toBe("failed");
    expect(classifyLessonOutcome({ recalled: false, triggerFired: true })).toBe("missed");
    expect(classifyLessonOutcome({ recalled: false, triggerFired: false })).toBe("noop");
  });

  test("calculates rates over triggered/relevant outcomes", () => {
    expect(outcomeRate(["helped", "failed", "missed", "noop"], "helped")).toBe(1 / 3);
  });
});

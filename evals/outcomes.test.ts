import { describe, expect, test } from "bun:test";
import { classifyLessonOutcome, outcomeRate } from "./outcomes";

describe("lesson outcomes", () => {
  test("distinguishes helped, failed, missed, and noop", () => {
    expect(classifyLessonOutcome({ recalled: true, triggerFired: false }, true)).toBe("helped");
    expect(classifyLessonOutcome({ recalled: true, triggerFired: true }, true)).toBe("failed");
    expect(classifyLessonOutcome({ recalled: false, triggerFired: true }, true)).toBe("missed");
    expect(classifyLessonOutcome({ recalled: false, triggerFired: false }, true)).toBe("noop");
  });

  test("does not credit a lesson whose failure has never been seen", () => {
    expect(classifyLessonOutcome({ recalled: true, triggerFired: false }, false)).toBe("noop");
  });

  test("calculates rates over triggered/relevant outcomes", () => {
    expect(outcomeRate(["helped", "failed", "missed", "noop"], "helped")).toBe(1 / 3);
  });
});

import { describe, test, expect } from "bun:test";
import {
  ALWAYS_SEGMENT,
  buildMemoryEntryPath,
  describeUnusableSubject,
  slugifyMemorySegment,
} from "./entry-path";

describe("slugifyMemorySegment", () => {
  test("kebab-cases free text", () => {
    expect(slugifyMemorySegment("Rendered Output Opening")).toBe("rendered-output-opening");
  });

  test("gives one subject one filename however it is spelled", () => {
    const spellings = ["Café préféré", "cafe prefere", "CAFE  PREFERE!"];
    const slugs = new Set(spellings.map(slugifyMemorySegment));
    expect([...slugs]).toEqual(["cafe-prefere"]);
  });

  test("leaves no trailing separator after truncation", () => {
    expect(slugifyMemorySegment("wordy ".repeat(60))).not.toMatch(/-$/);
  });

  test("reserves room for the extension so the path guardrail cannot reject it", () => {
    expect(`${slugifyMemorySegment("x".repeat(400))}.md`.length).toBeLessThanOrEqual(128);
  });
});

describe("describeUnusableSubject", () => {
  test("accepts a subject that survives slugification", () => {
    expect(describeUnusableSubject("favorite coffee")).toBeUndefined();
  });

  test("refuses a subject that would write a bare dotfile", () => {
    for (const subject of ["日本語の設定", "🎉", "???"]) {
      expect(describeUnusableSubject(subject)).toContain("Latin letters");
    }
  });
});

describe("buildMemoryEntryPath", () => {
  test("stores an entry with no topic as in force on every task", () => {
    expect(buildMemoryEntryPath({ scope: "personal", subject: "Rendered output opening" })).toBe(
      `personal/${ALWAYS_SEGMENT}/rendered-output-opening.md`,
    );
  });

  test("stores a topic entry under that topic", () => {
    expect(
      buildMemoryEntryPath({ scope: "personal", subject: "Artboard scaling", topic: "Mood Board" }),
    ).toBe("personal/when/mood-board/artboard-scaling.md");
  });

  test("treats an empty topic as no topic rather than an empty directory", () => {
    expect(buildMemoryEntryPath({ scope: "personal", subject: "x", topic: "  " })).toBe(
      `personal/${ALWAYS_SEGMENT}/x.md`,
    );
  });
});

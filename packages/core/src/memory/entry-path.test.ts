import { describe, test, expect } from "bun:test";
import {
  GLOBAL_WORKFLOW_SEGMENT,
  buildMemoryEntryPath,
  describeMemoryPathKindMismatch,
  isMemoryEntryKind,
  isWorkflowScopedKind,
  parseMemoryEntryPath,
  slugifyMemorySegment,
} from "./entry-path";

describe("slugifyMemorySegment", () => {
  test("kebab-cases free text", () => {
    expect(slugifyMemorySegment("Rendered Output Opening")).toBe("rendered-output-opening");
  });

  test("strips punctuation and collapses separators", () => {
    expect(slugifyMemorySegment("auto-open   the render!!")).toBe("auto-open-the-render");
  });

  test("trims leading and trailing separators", () => {
    expect(slugifyMemorySegment("  --moodboard--  ")).toBe("moodboard");
  });

  test("produces the same slug for equivalent subjects so repeat writes collide", () => {
    expect(slugifyMemorySegment("Auto Open Render")).toBe(slugifyMemorySegment("auto-open-render"));
  });
});

describe("parseMemoryEntryPath", () => {
  test("parses a fact path without a workflow segment", () => {
    expect(parseMemoryEntryPath("personal/facts/timezone.md")).toEqual({
      scope: "personal",
      kind: "fact",
      workflow: undefined,
      slug: "timezone.md",
    });
  });

  test("parses a workflow-scoped preference", () => {
    expect(parseMemoryEntryPath("personal/preferences/moodboard/artboard-scaling.md")).toEqual({
      scope: "personal",
      kind: "preference",
      workflow: "moodboard",
      slug: "artboard-scaling.md",
    });
  });

  test("reports a _global preference as having no workflow", () => {
    const parsed = parseMemoryEntryPath(
      `personal/preferences/${GLOBAL_WORKFLOW_SEGMENT}/auto-open-render.md`,
    );
    expect(parsed?.workflow).toBeUndefined();
    expect(parsed?.kind).toBe("preference");
  });

  test("parses a workflow-scoped lesson", () => {
    expect(parseMemoryEntryPath("personal/lessons/moodboard/artboard-autoscale.md")?.kind).toBe(
      "lesson",
    );
  });

  test("treats a legacy untyped path as unparsed so existing stores keep working", () => {
    expect(parseMemoryEntryPath("personal/notes/old-thing.md")).toBeUndefined();
  });

  test("does not mistake a reserved skills path for a typed entry", () => {
    expect(parseMemoryEntryPath("personal/skills/moodboard/SKILL.md")).toBeUndefined();
  });

  test("rejects a fact carrying a workflow segment", () => {
    expect(parseMemoryEntryPath("personal/facts/moodboard/timezone.md")).toBeUndefined();
  });

  test("rejects a workflow-scoped kind missing its workflow segment", () => {
    expect(parseMemoryEntryPath("personal/preferences/auto-open.md")).toBeUndefined();
  });
});

describe("buildMemoryEntryPath", () => {
  test("builds a fact path", () => {
    expect(buildMemoryEntryPath({ scope: "personal", kind: "fact", subject: "Timezone" })).toBe(
      "personal/facts/timezone.md",
    );
  });

  test("defaults a workflow-scoped kind to _global when no workflow is given", () => {
    expect(
      buildMemoryEntryPath({
        scope: "personal",
        kind: "preference",
        subject: "Rendered output opening",
      }),
    ).toBe(`personal/preferences/${GLOBAL_WORKFLOW_SEGMENT}/rendered-output-opening.md`);
  });

  test("slugifies the workflow tag", () => {
    expect(
      buildMemoryEntryPath({
        scope: "personal",
        kind: "lesson",
        subject: "Artboard scaling",
        workflow: "Mood Board",
      }),
    ).toBe("personal/lessons/mood-board/artboard-scaling.md");
  });

  test("round-trips through parseMemoryEntryPath", () => {
    const path = buildMemoryEntryPath({
      scope: "personal",
      kind: "preference",
      subject: "Artboard scaling",
      workflow: "moodboard",
    });
    expect(parseMemoryEntryPath(path)).toEqual({
      scope: "personal",
      kind: "preference",
      workflow: "moodboard",
      slug: "artboard-scaling.md",
    });
  });
});

describe("describeMemoryPathKindMismatch", () => {
  test("accepts a path that agrees with the declared kind", () => {
    expect(describeMemoryPathKindMismatch("personal/facts/timezone.md", "fact")).toBeUndefined();
  });

  test("rejects a preference filed under facts", () => {
    const message = describeMemoryPathKindMismatch("personal/facts/auto-open.md", "preference");
    expect(message).toContain("stores a fact");
    expect(message).toContain("preference");
  });

  test("explains the expected shape for an unparseable path", () => {
    const message = describeMemoryPathKindMismatch("personal/whatever.md", "preference");
    expect(message).toContain("<workflow|_global>");
  });

  test("explains the expected shape for a fact without a workflow segment", () => {
    const message = describeMemoryPathKindMismatch("personal/whatever.md", "fact");
    expect(message).toContain("<scope>/facts/<slug>.md");
  });
});

describe("kind predicates", () => {
  test("recognises the writable kinds", () => {
    expect(isMemoryEntryKind("fact")).toBe(true);
    expect(isMemoryEntryKind("preference")).toBe(true);
    expect(isMemoryEntryKind("lesson")).toBe(true);
  });

  test("rejects skill, which is written through manage_skill rather than manage_memory", () => {
    expect(isMemoryEntryKind("skill")).toBe(false);
  });

  test("only preferences and lessons are workflow-scoped", () => {
    expect(isWorkflowScopedKind("preference")).toBe(true);
    expect(isWorkflowScopedKind("lesson")).toBe(true);
    expect(isWorkflowScopedKind("fact")).toBe(false);
  });
});

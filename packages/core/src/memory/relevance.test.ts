import { describe, expect, test } from "bun:test";
import type { MemoryEntryInForce } from "@/core/interfaces/memory-service";
import { resolveRelevantMemories } from "./relevance";

const entry = (scope: string, topic: string, path: string): MemoryEntryInForce => ({
  path: `${scope}/when/${topic}/${path}.md`,
  scope,
  topic,
  summary: `${topic} preference`,
});

describe("resolveRelevantMemories", () => {
  test("composes matching entries from multiple scopes", () => {
    expect(
      resolveRelevantMemories(
        [entry("personal", "colleagues", "professional"), entry("email", "email", "signature")],
        { relationship: "colleagues", medium: "email" },
      ).map((item) => item.path),
    ).toEqual(["email/when/email/signature.md", "personal/when/colleagues/professional.md"]);
  });

  test("does not match a topic as a substring", () => {
    expect(
      resolveRelevantMemories([entry("personal", "board", "tone")], {
        operation: "dashboard",
      }),
    ).toEqual([]);
  });

  test("supports short topics", () => {
    expect(
      resolveRelevantMemories([entry("project", "ux", "style")], { project: "UX" }),
    ).toHaveLength(1);
  });

  test("orders more specific compound topics first", () => {
    const result = resolveRelevantMemories(
      [entry("personal", "email", "general"), entry("project", "email colleagues", "specific")],
      { medium: "email", relationship: "colleagues" },
    );
    expect(result.map((item) => item.path)).toEqual([
      "project/when/email colleagues/specific.md",
      "personal/when/email/general.md",
    ]);
  });
});

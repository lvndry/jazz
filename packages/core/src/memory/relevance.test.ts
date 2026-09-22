import { describe, expect, test } from "bun:test";
import type { MemoryEntryInForce } from "@/core/interfaces/memory-service";
import { resolveRelevantMemories, topicMatchesDimensions } from "./relevance";

const entry = (scope: string, topic: string, slug: string): MemoryEntryInForce => ({
  path: `${scope}/when/${topic}/${slug}.md`,
  scope,
  topic,
  summary: `${topic} preference`,
});

describe("topicMatchesDimensions", () => {
  test("matches a topic token against any dimension", () => {
    expect(topicMatchesDimensions("email", { medium: "email" })).toBe(true);
    expect(topicMatchesDimensions("colleagues", { relationship: "colleagues" })).toBe(true);
  });

  test("does not match a topic as a substring", () => {
    expect(topicMatchesDimensions("board", { operation: "dashboard" })).toBe(false);
  });

  test("supports short topics", () => {
    expect(topicMatchesDimensions("ux", { project: "UX" })).toBe(true);
  });

  test("a compound topic needs every token", () => {
    expect(topicMatchesDimensions("email-colleagues", { medium: "email" })).toBe(false);
    expect(
      topicMatchesDimensions("email-colleagues", { medium: "email", relationship: "colleagues" }),
    ).toBe(true);
  });

  test("compares a free-text dimension the way topic directories are named", () => {
    expect(topicMatchesDimensions("mood-board", { operation: "Mood Board" })).toBe(true);
  });
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

  test("leaves out entries whose topic is not a dimension", () => {
    expect(
      resolveRelevantMemories([entry("personal", "friends", "jokes")], {
        relationship: "colleagues",
      }),
    ).toEqual([]);
  });

  test("orders more specific compound topics first", () => {
    const result = resolveRelevantMemories(
      [entry("personal", "email", "general"), entry("project", "email-colleagues", "specific")],
      { medium: "email", relationship: "colleagues" },
    );
    expect(result.map((item) => item.path)).toEqual([
      "project/when/email-colleagues/specific.md",
      "personal/when/email/general.md",
    ]);
  });
});

import { describe, expect, it } from "bun:test";
import { getSkillIndexLine, scoreSkillsForQuery, type SkillMetadata } from "./skill-service";

const skill = (overrides: Partial<SkillMetadata> & Pick<SkillMetadata, "name">): SkillMetadata => ({
  description: "",
  path: `/tmp/${overrides.name}`,
  source: "builtin",
  ...overrides,
});

describe("getSkillIndexLine", () => {
  it("returns the full description", () => {
    expect(
      getSkillIndexLine(
        skill({
          name: "email",
          description: "Triage and reply to inbox messages. Detailed instructions follow.",
        }),
      ),
    ).toBe("Triage and reply to inbox messages. Detailed instructions follow.");
  });

  it("returns the full description even when long", () => {
    expect(getSkillIndexLine(skill({ name: "email", description: "a".repeat(200) }))).toBe(
      "a".repeat(200),
    );
  });

  it("returns name when description is empty", () => {
    expect(getSkillIndexLine(skill({ name: "lonely" }))).toBe("lonely");
  });
});

describe("scoreSkillsForQuery", () => {
  const skills = [
    skill({
      name: "email",
      description: "Process inbox messages, summarize threads, draft replies.",
    }),
    skill({
      name: "code-review",
      description: "Inspect diffs, identify bugs, suggest improvements.",
    }),
    skill({
      name: "deep-research",
      description: "Conduct thorough research with citations and synthesis.",
    }),
    skill({
      name: "obsidian",
      description: "Notes vault for inbox of ideas and journal.",
    }),
  ];

  it("ranks exact name match highest", () => {
    const result = scoreSkillsForQuery("email", skills);
    expect(result[0]?.name).toBe("email");
  });

  it("matches by description word", () => {
    const result = scoreSkillsForQuery("diffs", skills);
    expect(result.find((s) => s.name === "code-review")).toBeDefined();
  });

  it("matches by description", () => {
    const result = scoreSkillsForQuery("summarize", skills);
    expect(result[0]?.name).toBe("email");
  });

  it("matches by description as last resort", () => {
    const result = scoreSkillsForQuery("synthesis", skills);
    expect(result[0]?.name).toBe("deep-research");
  });

  it("respects the limit parameter", () => {
    const result = scoreSkillsForQuery("inbox", skills, 1);
    expect(result.length).toBe(1);
  });

  it("returns empty for empty query", () => {
    expect(scoreSkillsForQuery("", skills)).toEqual([]);
    expect(scoreSkillsForQuery("   ", skills)).toEqual([]);
  });

  it("returns empty when no skill matches", () => {
    expect(scoreSkillsForQuery("nonexistent_token_xyz", skills)).toEqual([]);
  });

  it("breaks score ties alphabetically by name", () => {
    const ties = [
      skill({ name: "zebra", description: "shared keyword foo" }),
      skill({ name: "apple", description: "shared keyword foo" }),
      skill({ name: "mango", description: "shared keyword foo" }),
    ];
    const result = scoreSkillsForQuery("foo", ties);
    expect(result.map((s) => s.name)).toEqual(["apple", "mango", "zebra"]);
  });

  it("scores name substring match higher than description match", () => {
    const candidates = [
      skill({ name: "email-skill", description: "irrelevant content" }),
      skill({ name: "other", description: "deals with email content" }),
    ];
    const result = scoreSkillsForQuery("email", candidates);
    expect(result[0]?.name).toBe("email-skill");
  });
});

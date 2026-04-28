import { describe, expect, it } from "bun:test";
import {
  getSkillIndexLine,
  matchSkillTriggers,
  scoreSkillsForQuery,
  type SkillMetadata,
} from "./skill-service";

const skill = (overrides: Partial<SkillMetadata> & Pick<SkillMetadata, "name">): SkillMetadata => ({
  description: "",
  path: `/tmp/${overrides.name}`,
  source: "builtin",
  ...overrides,
});

describe("getSkillIndexLine", () => {
  it("uses tagline when present", () => {
    expect(
      getSkillIndexLine(
        skill({
          name: "email",
          tagline: "inbox triage and reply drafting",
          description: "A long, multi-paragraph description that we don't want in the index.",
        }),
      ),
    ).toBe("inbox triage and reply drafting");
  });

  it("falls back to first sentence of description when no tagline", () => {
    expect(
      getSkillIndexLine(
        skill({
          name: "email",
          description: "Triage and reply to inbox messages. Detailed instructions follow.",
        }),
      ),
    ).toBe("Triage and reply to inbox messages.");
  });

  it("truncates description with ellipsis when no sentence boundary fits", () => {
    expect(
      getSkillIndexLine(
        skill({
          name: "email",
          description: "a".repeat(200),
        }),
      ),
    ).toBe("a".repeat(77) + "...");
  });

  it("returns name when description is empty", () => {
    expect(getSkillIndexLine(skill({ name: "lonely" }))).toBe("lonely");
  });

  it("ignores empty/whitespace tagline", () => {
    expect(
      getSkillIndexLine(
        skill({ name: "x", tagline: "   ", description: "Real description here." }),
      ),
    ).toBe("Real description here.");
  });
});

describe("matchSkillTriggers", () => {
  const skills = [
    skill({ name: "email", triggers: ["email", "inbox", "gmail"] }),
    skill({ name: "git", triggers: ["commit", "push", "git"] }),
    skill({ name: "research", triggers: ["research", "investigate"] }),
    skill({ name: "no-triggers" }),
  ];

  it("returns matched skill names for whole-word substring match", () => {
    expect(matchSkillTriggers("triage my inbox", skills)).toEqual(["email"]);
  });

  it("matches multiple skills when multiple triggers fire", () => {
    expect(
      [...matchSkillTriggers("research the inbox metrics and commit findings", skills)].sort(),
    ).toEqual(["email", "git", "research"]);
  });

  it("is case-insensitive", () => {
    expect(matchSkillTriggers("CHECK MY GMAIL", skills)).toEqual(["email"]);
  });

  it("rejects partial-word matches (no false positive on 'committee')", () => {
    expect(matchSkillTriggers("the committee meets tomorrow", skills)).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(matchSkillTriggers("", skills)).toEqual([]);
  });

  it("returns empty when no skills supplied", () => {
    expect(matchSkillTriggers("inbox", [])).toEqual([]);
  });

  it("ignores skills with no triggers", () => {
    expect(matchSkillTriggers("anything", [skill({ name: "no-triggers" })])).toEqual([]);
  });

  it("matches multi-word triggers as a phrase", () => {
    const s = [skill({ name: "triage", triggers: ["inbox triage"] })];
    expect(matchSkillTriggers("perform inbox triage now", s)).toEqual(["triage"]);
    expect(matchSkillTriggers("inbox is full, triage needed", s)).toEqual([]);
  });

  it("escapes regex metacharacters in triggers", () => {
    const s = [skill({ name: "test", triggers: ["c++"] })];
    // c++ should match literal c++, not match c (regex meta interpretation)
    expect(matchSkillTriggers("write some c++ code", s)).toEqual(["test"]);
    expect(matchSkillTriggers("write some c code", s)).toEqual([]);
  });
});

describe("scoreSkillsForQuery", () => {
  const skills = [
    skill({
      name: "email",
      tagline: "inbox triage and reply drafting",
      description: "Process inbox messages, summarize threads, draft replies.",
      triggers: ["inbox", "gmail"],
    }),
    skill({
      name: "code-review",
      tagline: "review pull requests and flag risks",
      description: "Inspect diffs, identify bugs, suggest improvements.",
      triggers: ["pr", "review"],
    }),
    skill({
      name: "deep-research",
      tagline: "multi-source investigation",
      description: "Conduct thorough research with citations and synthesis.",
      triggers: ["research", "investigate"],
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

  it("matches by trigger word-boundary", () => {
    const result = scoreSkillsForQuery("review", skills);
    expect(result.find((s) => s.name === "code-review")).toBeDefined();
  });

  it("matches by tagline", () => {
    const result = scoreSkillsForQuery("triage", skills);
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

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  citationGroundingCheck,
  comprehensionCheck,
  constraintCheck,
  fileStateCheck,
  toolUsedCheck,
} from "./checks";
import type { OneShotResult } from "./types";

function result(overrides: Partial<OneShotResult> = {}): OneShotResult {
  return {
    ok: true,
    answer: "",
    toolCalls: [],
    costUSD: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    eventsPath: "",
    ...overrides,
  };
}

describe("toolUsedCheck", () => {
  it("passes when the tool was called, fails otherwise", () => {
    expect(
      toolUsedCheck(
        result({ toolCalls: [{ id: "1", name: "edit_file", arguments: "{}" }] }),
        "edit_file",
      ).pass,
    ).toBe(true);
    expect(toolUsedCheck(result(), "edit_file").pass).toBe(false);
  });
});

describe("fileStateCheck", () => {
  it("passes when the file exists with required content", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-fs-"));
    writeFileSync(join(dir, "out.md"), "hello DONE world");
    expect(fileStateCheck(dir, { path: "out.md", mustContain: ["DONE"] }).pass).toBe(true);
    expect(fileStateCheck(dir, { path: "out.md", mustContain: ["MISSING"] }).pass).toBe(false);
    expect(fileStateCheck(dir, { path: "nope.md" }).pass).toBe(false);
  });
});

describe("constraintCheck", () => {
  it("passes only when all constraints hold", () => {
    const r = result({ answer: "budget 500, date monday" });
    const ok = constraintCheck(r, [
      { name: "budget", test: (a) => a.includes("500") },
      { name: "date", test: (a) => a.includes("monday") },
    ]);
    expect(ok.pass).toBe(true);
    const bad = constraintCheck(r, [{ name: "conflict", test: (a) => a.includes("tuesday") }]);
    expect(bad.pass).toBe(false);
    expect(bad.detail).toContain("conflict");
  });
});

describe("citationGroundingCheck", () => {
  it("passes when the answer cites a corpus file and quotes a real line from it", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-corpus-"));
    mkdirSync(join(dir, "corpus"));
    writeFileSync(
      join(dir, "corpus", "source-a.txt"),
      "The capital of France is Paris according to the atlas.",
    );
    const grounded = result({
      answer: "Per source-a.txt: The capital of France is Paris according to the atlas.",
    });
    expect(citationGroundingCheck(grounded, join(dir, "corpus")).pass).toBe(true);
    const ungrounded = result({ answer: "Paris, obviously." });
    expect(citationGroundingCheck(ungrounded, join(dir, "corpus")).pass).toBe(false);
  });
});

describe("comprehensionCheck", () => {
  it("scores the fraction of questions the injected judge deems answerable", async () => {
    const alwaysYes = async () => 1;
    const alwaysNo = async () => 0;
    const qa = [
      { question: "what is recursion?", answer: "a function calling itself" },
      { question: "base case?", answer: "the stop condition" },
    ];
    const good = await comprehensionCheck(result({ answer: "recursion is ..." }), qa, alwaysYes);
    expect(good.pass).toBe(true);
    expect(good.score).toBe(1);
    const bad = await comprehensionCheck(result({ answer: "vague" }), qa, alwaysNo);
    expect(bad.pass).toBe(false);
    expect(bad.score).toBe(0);
  });
});

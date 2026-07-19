import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  citationGroundingCheck,
  comprehensionCheck,
  constraintCheck,
  fileStateCheck,
  machineSpecGroundingCheck,
  plausibleFreeDiskGB,
  toolGroundedAnswerCheck,
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

describe("machineSpecGroundingCheck", () => {
  const probePatterns = [/system_profiler/i, /sysctl\b/i];
  const askBackPatterns = [/what(?:'s| is) your ram/i];

  it("passes when the answer cites the real RAM figure", () => {
    const ramGB = Math.round(totalmem() / 1024 ** 3);
    const r = result({ answer: `This machine has ${ramGB}GB of RAM, so try a 7B model.` });
    expect(machineSpecGroundingCheck(r, { probePatterns, askBackPatterns }).pass).toBe(true);
  });

  it("passes when the agent ran a system probe command", () => {
    const r = result({
      answer: "Based on the probe output, a 7B model fits comfortably.",
      toolCalls: [
        { id: "1", name: "execute_command", arguments: '{"command":"sysctl hw.memsize"}' },
      ],
    });
    expect(machineSpecGroundingCheck(r, { probePatterns, askBackPatterns }).pass).toBe(true);
  });

  it("fails on generic RAM-bucket guidance with no probe", () => {
    const r = result({
      answer: "If you have 8-16GB of RAM, try a 7B model; for 32GB+, go bigger.",
    });
    expect(machineSpecGroundingCheck(r, { probePatterns, askBackPatterns }).pass).toBe(false);
  });

  it("fails when the agent asks the user for their specs", () => {
    const r = result({ answer: "What's your RAM? I can recommend a model once I know." });
    expect(machineSpecGroundingCheck(r, { probePatterns, askBackPatterns }).pass).toBe(false);
  });
});

describe("toolGroundedAnswerCheck", () => {
  it("fails when no grounding tool was called, even if the answer looks right", () => {
    const r = result({ answer: "This repo uses ava for testing." });
    const check = toolGroundedAnswerCheck(r, {
      toolNames: ["read_file", "grep"],
      answerPatterns: [/\bava\b/i],
    });
    expect(check.pass).toBe(false);
  });

  it("fails when a grounding tool was called but the answer misses the grounded content", () => {
    const r = result({
      answer: "This is probably a Jest project.",
      toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"package.json"}' }],
    });
    const check = toolGroundedAnswerCheck(r, {
      toolNames: ["read_file", "grep"],
      answerPatterns: [/\bava\b/i],
    });
    expect(check.pass).toBe(false);
  });

  it("passes when a grounding tool was called and the answer reflects real content", () => {
    const r = result({
      answer: "This repo uses ava for testing.",
      toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"package.json"}' }],
    });
    const check = toolGroundedAnswerCheck(r, {
      toolNames: ["read_file", "grep"],
      answerPatterns: [/\bava\b/i],
    });
    expect(check.pass).toBe(true);
  });

  it("honors toolArgPatterns when set", () => {
    const r = result({
      answer: "You have 400GB free.",
      toolCalls: [{ id: "1", name: "execute_command", arguments: '{"command":"ls -la"}' }],
    });
    const check = toolGroundedAnswerCheck(r, {
      toolNames: ["execute_command"],
      toolArgPatterns: [/\bdf\s+-h?\b/i],
      answerPatterns: [/\d+\s*gb\b/i],
    });
    expect(check.pass).toBe(false);
  });
});

describe("plausibleFreeDiskGB", () => {
  it("returns a range that brackets the real free space of the given path", () => {
    const { min, max } = plausibleFreeDiskGB(tmpdir());
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });
});

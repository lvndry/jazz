import { describe, expect, it } from "bun:test";
import fixtures from "./harness-prompt-fixtures.json";
import { renderHarnessPrompt, renderHarnessPromptParts, type HarnessPromptOptions } from "./shared";

describe("renderHarnessPrompt output", () => {
  it.each(fixtures)("is byte-identical to the recorded render for $name", (fixture) => {
    expect(renderHarnessPrompt(fixture.options as HarnessPromptOptions)).toBe(fixture.expected);
  });

  it.each(fixtures)("$name: the two parts join into the same block", (fixture) => {
    const { stable, dynamic } = renderHarnessPromptParts(fixture.options as HarnessPromptOptions);

    expect(dynamic === undefined ? stable : `${stable}\n\n${dynamic}`).toBe(fixture.expected);
  });

  it("keeps the skills and deferred-tool indexes out of the stable part", () => {
    const { stable, dynamic } = renderHarnessPromptParts({
      hasTools: true,
      skillsIndex: "- alpha: first",
      deferredToolsIndex: "- beta: second",
    });

    expect(stable).not.toContain("alpha");
    expect(stable).not.toContain("beta");
    expect(dynamic).toContain("alpha");
    expect(dynamic).toContain("beta");
  });
});

const GATED_TOOLS: readonly {
  readonly flag: keyof HarnessPromptOptions;
  readonly toolName: string;
}[] = [
  { flag: "hasMemoryRecall", toolName: "view_memory" },
  { flag: "hasMemoryWrite", toolName: "manage_memory" },
  { flag: "hasLessons", toolName: "propose_lesson" },
];

function numberedRuleCount(prompt: string): number {
  return prompt.split("\n").filter((line) => /^\d+\. /.test(line)).length;
}

describe("renderHarnessPrompt tool gating", () => {
  it.each(GATED_TOOLS)("names $toolName only when $flag is set", ({ flag, toolName }) => {
    const without = renderHarnessPrompt({ hasTools: true });
    const withTool = renderHarnessPrompt({ hasTools: true, [flag]: true });

    expect(without).not.toContain(toolName);
    expect(withTool).toContain(toolName);
    expect(numberedRuleCount(withTool)).toBe(numberedRuleCount(without) + 1);
  });

  it("names none of the memory tools for a run that offers none", () => {
    const prompt = renderHarnessPrompt({ hasTools: false });

    for (const { toolName } of GATED_TOOLS) {
      expect(prompt).not.toContain(toolName);
    }
  });

  it("numbers the rules consecutively whichever are gated in", () => {
    const prompt = renderHarnessPrompt({ hasTools: true, hasMemoryWrite: true, hasLessons: true });
    const numbers = prompt
      .split("\n")
      .flatMap((line) => /^(\d+)\. /.exec(line)?.[1] ?? [])
      .map(Number);

    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});

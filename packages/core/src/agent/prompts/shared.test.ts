import { describe, expect, it } from "bun:test";
import { renderHarnessPrompt, type HarnessPromptOptions } from "./shared";

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

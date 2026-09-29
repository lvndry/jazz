import { describe, expect, test } from "bun:test";
import { sessionOpenLine } from "./session-open";

describe("sessionOpenLine", () => {
  const agent = {
    name: "sol",
    config: { llm: { provider: "openai", model: "gpt-5.6", reasoning: "medium" } },
  } as Parameters<typeof sessionOpenLine>[0];

  test("names who, which model, how hard it thinks and where, in one line", () => {
    expect(sessionOpenLine(agent, "/home/me/github/jazz", "/home/me")).toBe(
      "sol · openai/gpt-5.6 · reasoning medium · ~/github/jazz",
    );
  });

  test("leaves a directory outside home as it is", () => {
    expect(sessionOpenLine(agent, "/srv/work", "/home/me")).toEndWith("· /srv/work");
    expect(sessionOpenLine(agent, "/home/meadow", "/home/me")).toEndWith("· /home/meadow");
  });
});

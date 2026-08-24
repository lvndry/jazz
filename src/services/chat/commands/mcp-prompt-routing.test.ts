import { beforeEach, describe, expect, test } from "bun:test";
import { filterCommandsByPrefix, setMcpPromptCommands, setSkillCommands } from "./constants";
import { parseSpecialCommand } from "./parser";

beforeEach(() => {
  setSkillCommands([]);
  setMcpPromptCommands([]);
});

describe("MCP prompt slash commands", () => {
  test("routes a registered prompt to runMcpPrompt", () => {
    setMcpPromptCommands([{ name: "linear:create-issue", description: "File an issue" }]);

    expect(parseSpecialCommand("/linear:create-issue title=Bug")).toEqual({
      type: "runMcpPrompt",
      args: ["linear:create-issue", "title=Bug"],
    });
  });

  test("an unregistered prompt name is still an unknown command", () => {
    expect(parseSpecialCommand("/linear:create-issue")?.type).toBe("unknown");
  });

  test("appears in autocomplete tagged as an MCP prompt", () => {
    setMcpPromptCommands([{ name: "linear:create-issue", description: "File an issue" }]);

    const matches = filterCommandsByPrefix("linear");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe("mcp-prompt");
  });

  test("a built-in command wins a name collision", () => {
    // A server must not be able to shadow /help by naming a prompt after it.
    setMcpPromptCommands([{ name: "help", description: "hostile prompt" }]);

    expect(parseSpecialCommand("/help")?.type).toBe("help");
    expect(filterCommandsByPrefix("help").every((cmd) => cmd.source === undefined)).toBe(true);
  });

  test("a skill wins a name collision", () => {
    setSkillCommands([{ name: "deep-research", description: "a skill" }]);
    setMcpPromptCommands([{ name: "deep-research", description: "a prompt" }]);

    expect(parseSpecialCommand("/deep-research")?.type).toBe("runSkill");
  });

  test("re-registering replaces the previous server's prompts", () => {
    setMcpPromptCommands([{ name: "old:prompt", description: "gone" }]);
    setMcpPromptCommands([{ name: "new:prompt", description: "here" }]);

    expect(parseSpecialCommand("/old:prompt")?.type).toBe("unknown");
    expect(parseSpecialCommand("/new:prompt")?.type).toBe("runMcpPrompt");
  });
});

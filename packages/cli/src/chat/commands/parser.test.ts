import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_COMMANDS, setSkillCommands } from "./constants";
import { isCommandInput, isShellEscape, parseSpecialCommand } from "./parser";

describe("parseSpecialCommand", () => {
  it("keeps a rename title intact without limiting its length", () => {
    const title = `研究  Café 🪷\t${"long title ".repeat(1000).trim()}`;
    expect(parseSpecialCommand(`/ReNaMe ${title}`)).toEqual({ type: "rename", args: [title] });
    expect(parseSpecialCommand("/rename")).toEqual({ type: "rename", args: [] });
    expect(parseSpecialCommand("/new")).toEqual({ type: "start", args: [] });
    expect(parseSpecialCommand("/create")).toEqual({ type: "create", args: [] });
    expect(parseSpecialCommand("/start")).toEqual({ type: "start", args: [] });
  });
  describe("recognized commands", () => {
    it("should parse /new as a fresh conversation command", () => {
      const result = parseSpecialCommand("/new");
      expect(result.type).toBe("start");
      expect(result.args).toEqual([]);
    });

    it("should parse /create command", () => {
      const result = parseSpecialCommand("/create");
      expect(result.type).toBe("create");
      expect(result.args).toEqual([]);
    });

    it("should parse /help command", () => {
      const result = parseSpecialCommand("/help");
      expect(result.type).toBe("help");
      expect(result.args).toEqual([]);
    });

    it("should parse /clear command", () => {
      const result = parseSpecialCommand("/clear");
      expect(result.type).toBe("clear");
      expect(result.args).toEqual([]);
    });

    it("should parse /tools command", () => {
      const result = parseSpecialCommand("/tools");
      expect(result.type).toBe("tools");
      expect(result.args).toEqual([]);
    });

    it("should parse /agents command", () => {
      const result = parseSpecialCommand("/agents");
      expect(result.type).toBe("agents");
      expect(result.args).toEqual([]);
    });

    it("should parse /peers command", () => {
      const result = parseSpecialCommand("/peers");
      expect(result.type).toBe("peers");
      expect(result.args).toEqual([]);
    });

    it("should parse /fork command", () => {
      const result = parseSpecialCommand("/fork");
      expect(result.type).toBe("fork");
      expect(result.args).toEqual([]);
    });

    it("should parse /detach with a host without treating it as model text", () => {
      expect(parseSpecialCommand("/detach lysk")).toEqual({
        type: "detach",
        args: ["lysk"],
      });
    });

    it("should parse /compact command", () => {
      const result = parseSpecialCommand("/compact");
      expect(result.type).toBe("compact");
      expect(result.args).toEqual([]);
    });

    it("should parse /copy command", () => {
      const result = parseSpecialCommand("/copy");
      expect(result.type).toBe("copy");
      expect(result.args).toEqual([]);
    });

    it("should parse /context command", () => {
      const result = parseSpecialCommand("/context");
      expect(result.type).toBe("context");
      expect(result.args).toEqual([]);
    });

    it("should parse /workflows command with no args", () => {
      const result = parseSpecialCommand("/workflows");
      expect(result.type).toBe("workflows");
      expect(result.args).toEqual([]);
    });

    it("should parse /info command", () => {
      const result = parseSpecialCommand("/info");
      expect(result.type).toBe("info");
      expect(result.args).toEqual([]);
    });

    it("should parse /stats as an alias of /info", () => {
      expect(parseSpecialCommand("/stats").type).toBe("info");
    });

    it("should parse /mcp command", () => {
      const result = parseSpecialCommand("/mcp");
      expect(result.type).toBe("mcp");
      expect(result.args).toEqual([]);
    });
  });

  describe("commands with arguments", () => {
    it("should parse /switch with single argument", () => {
      const result = parseSpecialCommand("/switch my-agent");
      expect(result.type).toBe("switch");
      expect(result.args).toEqual(["my-agent"]);
    });

    it("should parse /switch with multiple word agent name", () => {
      const result = parseSpecialCommand("/switch my cool agent");
      expect(result.type).toBe("switch");
      expect(result.args).toEqual(["my", "cool", "agent"]);
    });

    it("should handle extra whitespace in arguments", () => {
      const result = parseSpecialCommand("/switch   my-agent   ");
      expect(result.type).toBe("switch");
      expect(result.args).toEqual(["my-agent"]);
    });

    it("should parse /workflows create (pass-through to agent)", () => {
      const result = parseSpecialCommand("/workflows create");
      expect(result.type).toBe("workflows");
      expect(result.args).toEqual(["create"]);
    });

    it("should parse /workflows create my-newsletter", () => {
      const result = parseSpecialCommand("/workflows create my-newsletter");
      expect(result.type).toBe("workflows");
      expect(result.args).toEqual(["create", "my-newsletter"]);
    });

    it("should parse /limit usd 5", () => {
      const result = parseSpecialCommand("/limit usd 5");
      expect(result.type).toBe("limit");
      expect(result.args).toEqual(["usd", "5"]);
    });
  });

  describe("case insensitivity", () => {
    it("should handle uppercase commands", () => {
      const result = parseSpecialCommand("/NEW");
      expect(result.type).toBe("start");
    });

    it("should handle mixed case commands", () => {
      const result = parseSpecialCommand("/CrEaTe");
      expect(result.type).toBe("create");
    });
  });

  describe("unknown commands", () => {
    it("should return unknown for unrecognized commands", () => {
      const result = parseSpecialCommand("/invalid");
      expect(result.type).toBe("unknown");
      expect(result.args).toContain("invalid");
    });

    it("should parse /exit as the exit command", () => {
      expect(parseSpecialCommand("/exit").type).toBe("exit");
    });

    it("should return unknown for made-up commands", () => {
      const result = parseSpecialCommand("/foobar arg1 arg2");
      expect(result.type).toBe("unknown");
      expect(result.args).toEqual(["foobar", "arg1", "arg2"]);
    });
  });

  describe("non-command input", () => {
    it("should return unknown for text without slash", () => {
      const result = parseSpecialCommand("hello world");
      expect(result.type).toBe("unknown");
      expect(result.args).toEqual([]);
    });

    it("should return unknown for empty input", () => {
      const result = parseSpecialCommand("");
      expect(result.type).toBe("unknown");
      expect(result.args).toEqual([]);
    });

    it("should return unknown for whitespace only", () => {
      const result = parseSpecialCommand("   ");
      expect(result.type).toBe("unknown");
      expect(result.args).toEqual([]);
    });

    it("should handle slash in middle of text", () => {
      const result = parseSpecialCommand("hello/world");
      expect(result.type).toBe("unknown");
      expect(result.args).toEqual([]);
    });
  });

  describe("shell escapes", () => {
    it("preserves the complete command after a leading !", () => {
      expect(parseSpecialCommand("! ssh user@test rm -r folder")).toEqual({
        type: "shell",
        args: ["ssh user@test rm -r folder"],
      });
    });

    it("allows whitespace before the shell escape", () => {
      expect(parseSpecialCommand("  ! ls -la  ")).toEqual({
        type: "shell",
        args: ["ls -la"],
      });
    });

    it("does not treat a bare ! as a shell command", () => {
      expect(parseSpecialCommand("!").type).toBe("unknown");
    });

    it("requires a space or tab after the bang", () => {
      expect(parseSpecialCommand("!\tls").type).toBe("shell");
      expect(parseSpecialCommand("!!! urgent: call the bank").type).toBe("unknown");
      expect(parseSpecialCommand("!ls").type).toBe("unknown");
      expect(parseSpecialCommand("!important").type).toBe("unknown");
    });
  });

  describe("isShellEscape and isCommandInput", () => {
    it("recognizes a bang followed by a space as a shell escape", () => {
      expect(isShellEscape("! git status")).toBe(true);
      expect(isShellEscape("  ! git status")).toBe(true);
      expect(isShellEscape("! ")).toBe(true);
    });

    it("reads anything else starting with a bang as prose", () => {
      expect(isShellEscape("!!! urgent")).toBe(false);
      expect(isShellEscape("!ls")).toBe(false);
      expect(isShellEscape("!")).toBe(false);
      expect(isCommandInput("!!! urgent")).toBe(false);
    });

    it("counts slash commands and shell escapes as command input", () => {
      expect(isCommandInput("/help")).toBe(true);
      expect(isCommandInput("! ls")).toBe(true);
      expect(isCommandInput("hello")).toBe(false);
    });
  });

  describe("skill commands", () => {
    afterEach(() => {
      setSkillCommands([]);
    });

    it("should route a registered skill name to runSkill", () => {
      setSkillCommands([{ name: "deep-research", description: "Research a topic" }]);
      const result = parseSpecialCommand("/deep-research");
      expect(result.type).toBe("runSkill");
      expect(result.args).toEqual(["deep-research"]);
    });

    it("should carry trailing text as skill args", () => {
      setSkillCommands([{ name: "deep-research", description: "Research a topic" }]);
      const result = parseSpecialCommand("/deep-research best laptops 2026");
      expect(result.type).toBe("runSkill");
      expect(result.args).toEqual(["deep-research", "best", "laptops", "2026"]);
    });

    it("should still return unknown for unregistered skills", () => {
      setSkillCommands([{ name: "deep-research", description: "Research a topic" }]);
      const result = parseSpecialCommand("/not-a-skill");
      expect(result.type).toBe("unknown");
    });

    it("should let built-in commands win over a same-named skill", () => {
      setSkillCommands([{ name: "help", description: "colliding skill" }]);
      const result = parseSpecialCommand("/help");
      expect(result.type).toBe("help");
    });
  });

  describe("edge cases", () => {
    it("should handle just a slash", () => {
      const result = parseSpecialCommand("/");
      expect(result.type).toBe("unknown");
      // Empty command string becomes unknown with empty args
    });

    it("should handle leading/trailing whitespace", () => {
      const result = parseSpecialCommand("  /help  ");
      expect(result.type).toBe("help");
    });
  });
});

describe("CHAT_COMMANDS registry", () => {
  it("parses every advertised command and alias to its registered type", () => {
    const mismatched = CHAT_COMMANDS.flatMap((command) =>
      [command.name, ...(command.aliases ?? [])]
        .filter((name) => parseSpecialCommand(`/${name}`).type !== command.type)
        .map((name) => `/${name}`),
    );
    expect(mismatched).toEqual([]);
  });

  it("advertises /new as the canonical fresh-conversation command", () => {
    const command = CHAT_COMMANDS.find((entry) => entry.type === "start");
    expect(command?.name).toBe("new");
    expect(command?.aliases).toEqual(["start"]);
  });

  it("gives every command and alias a unique name", () => {
    const names = CHAT_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("parses /memory with its arguments", () => {
    expect(parseSpecialCommand("/memory forget personal/notes.md")).toEqual({
      type: "memory",
      args: ["forget", "personal/notes.md"],
    });
  });

  it("routes aliases to the command they name", () => {
    expect(parseSpecialCommand("/quit").type).toBe("exit");
    expect(parseSpecialCommand("/stats").type).toBe("info");
    expect(parseSpecialCommand("/models gpt-5")).toEqual({ type: "model", args: ["gpt-5"] });
  });
});

describe("a message that starts with a path", () => {
  it("is prose when the first word has another slash", () => {
    expect(parseSpecialCommand("/Users/me/shot.png what is this?").type).toBe("prose");
    expect(parseSpecialCommand("/tmp/ is full").type).toBe("prose");
  });

  it("is prose when the first word exists on disk", () => {
    expect(parseSpecialCommand("/tmp has too much in it").type).toBe("prose");
  });

  it("stays an unknown command when it is neither", () => {
    expect(parseSpecialCommand("/definitely-not-a-command now")).toEqual({
      type: "unknown",
      args: ["definitely-not-a-command", "now"],
    });
  });
});

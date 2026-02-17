import { describe, expect, it } from "bun:test";
import { parseSpecialCommand } from "./parser";

describe("parseSpecialCommand", () => {
  describe("recognized commands", () => {
    it("should parse /new command", () => {
      const result = parseSpecialCommand("/new");
      expect(result.type).toBe("new");
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

    it("should parse /fork command", () => {
      const result = parseSpecialCommand("/fork");
      expect(result.type).toBe("fork");
      expect(result.args).toEqual([]);
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

    it("should parse /stats command", () => {
      const result = parseSpecialCommand("/stats");
      expect(result.type).toBe("stats");
      expect(result.args).toEqual([]);
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
  });

  describe("case insensitivity", () => {
    it("should handle uppercase commands", () => {
      const result = parseSpecialCommand("/NEW");
      expect(result.type).toBe("new");
    });

    it("should handle mixed case commands", () => {
      const result = parseSpecialCommand("/HeLp");
      expect(result.type).toBe("help");
    });
  });

  describe("unknown commands", () => {
    it("should return unknown for unrecognized commands", () => {
      const result = parseSpecialCommand("/invalid");
      expect(result.type).toBe("unknown");
      expect(result.args).toContain("invalid");
    });

    it("should return unknown for /exit (handled separately)", () => {
      const result = parseSpecialCommand("/exit");
      expect(result.type).toBe("unknown");
      expect(result.args).toContain("exit");
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

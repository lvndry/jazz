import { decode as decodeToon } from "@toon-format/toon";
import { describe, expect, it, beforeEach } from "bun:test";
import { setLogFormat, getLogFormat, formatLogLineAsJson, formatLogLineAsPlain, formatLogLineAsToon } from "./logger";

describe("LoggerService", () => {
  beforeEach(() => {
    setLogFormat("plain");
  });

  it("should have default format set to plain", () => {
    expect(getLogFormat()).toBe("plain");
  });

  it("should allow changing format to json", () => {
    setLogFormat("json");
    expect(getLogFormat()).toBe("json");
  });

  it("should allow changing format to toon", () => {
    setLogFormat("toon");
    expect(getLogFormat()).toBe("toon");
  });

  describe("formatLogLineAsJson", () => {
    it("should format as a single-line JSON string", () => {
      const output = formatLogLineAsJson("info", "Test message", { key: "value" }, "session-123");
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe("INFO");
      expect(parsed.message).toBe("Test message");
      expect(parsed.key).toBe("value");
      expect(parsed.sessionId).toBe("session-123");
      expect(parsed.timestamp).toBeDefined();
      expect(output.endsWith("\n")).toBe(true);
      expect(output.split("\n").length).toBe(2); // One newline at end
    });

    it("should spread meta fields at top level", () => {
      const output = formatLogLineAsJson("error", "Error happened", { code: 500, detail: "DB error" });
      const parsed = JSON.parse(output);

      expect(parsed.code).toBe(500);
      expect(parsed.detail).toBe("DB error");
    });
  });

  describe("formatLogLineAsPlain", () => {
    it("should format as a human-readable string", () => {
      const output = formatLogLineAsPlain("warn", "Warning message", { foo: "bar" });

      expect(output).toContain("[WARN]");
      expect(output).toContain("Warning message");
      expect(output).toContain('{"foo":"bar"}');
      expect(output.endsWith("\n")).toBe(true);
    });
  });

  describe("formatLogLineAsToon", () => {
    it("should format as valid TOON", () => {
      const output = formatLogLineAsToon("info", "Test message", { key: "value" }, "session-123");

      // Remove trailing newline for parsing
      const toonStr = output.trim();
      const parsed = decodeToon(toonStr) as Record<string, unknown>;

      expect(parsed.level).toBe("INFO");
      expect(parsed.message).toBe("Test message");
      expect(parsed.sessionId).toBe("session-123");
      expect((parsed.meta as Record<string, unknown>).key).toBe("value");
      expect(parsed.timestamp).toBeDefined();
      expect(output.endsWith("\n")).toBe(true);
    });

    it("should be more compact than JSON", () => {
      const data = { foo: "bar", baz: 123 };
      const toonOutput = formatLogLineAsToon("info", "Test", data);
      const jsonOutput = formatLogLineAsJson("info", "Test", data);

      // TOON should generally be shorter
      expect(toonOutput.length).toBeLessThan(jsonOutput.length);
    });
  });
});

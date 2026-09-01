import { beforeEach, describe, expect, it } from "bun:test";
import {
  formatLogLineAsJson,
  formatLogLineAsPlain,
  formatToolCallLogLine,
  getLogFormat,
  setLogFormat,
} from "./logger";

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

  describe("formatLogLineAsJson", () => {
    it("should format as a single-line JSON string", () => {
      const output = formatLogLineAsJson("info", "Test message", { key: "value" }, "session-123");
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe("INFO");
      expect(parsed.message).toBe("Test message");
      expect(parsed.key).toBe("value");
      expect(parsed.conversationId).toBe("session-123");
      expect(parsed.timestamp).toBeDefined();
      expect(output.endsWith("\n")).toBe(true);
      expect(output.split("\n").length).toBe(2); // One newline at end
    });

    it("should spread meta fields at top level", () => {
      const output = formatLogLineAsJson("error", "Error happened", {
        code: 500,
        detail: "DB error",
      });
      const parsed = JSON.parse(output);

      expect(parsed.code).toBe(500);
      expect(parsed.detail).toBe("DB error");
    });

    it("redacts credential-bearing metadata keys at every depth", () => {
      const args = {
        apiKey: "top-secret",
        headers: { authorization: "Bearer also-secret", accept: "application/json" },
      };
      const output = formatLogLineAsJson("info", "Request", args);
      const parsed = JSON.parse(output);

      expect(parsed.apiKey).toBe("<redacted>");
      expect(parsed.headers).toEqual({ authorization: "<redacted>", accept: "application/json" });
      expect(output).not.toContain("top-secret");
      expect(output).not.toContain("also-secret");
      expect(args).toEqual({
        apiKey: "top-secret",
        headers: { authorization: "Bearer also-secret", accept: "application/json" },
      });
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

    it("redacts credential-bearing metadata keys", () => {
      const output = formatLogLineAsPlain("info", "Request", {
        credentials: { password: "top-secret" },
      });

      expect(output).toContain('"credentials":"<redacted>"');
      expect(output).not.toContain("top-secret");
    });
  });

  it("redacts tool arguments in plain and JSON session logs", () => {
    const args = {
      headers: { authorization: "Bearer tool-secret" },
      query: { access_token: "nested-tool-secret", page: 1 },
    };

    for (const format of ["plain", "json"] as const) {
      setLogFormat(format);
      const output = formatToolCallLogLine("session-123", "http_request", args);

      expect(output).toContain("<redacted>");
      expect(output).not.toContain("tool-secret");
      expect(output).not.toContain("nested-tool-secret");
    }
  });
});

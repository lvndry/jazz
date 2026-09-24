import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  formatLogLineAsJson,
  formatLogLineAsPlain,
  formatToolCallLogLine,
  getLogFormat,
  setLogFormat,
  summarizeToolCallArgs,
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
      expect(parsed.attributes.key).toBe("value");
      expect(parsed.conversationId).toBe("session-123");
      expect(parsed.timestamp).toBeDefined();
      expect(output.endsWith("\n")).toBe(true);
      expect(output.split("\n").length).toBe(2); // One newline at end
    });

    it("keeps metadata under attributes and seals reserved fields", () => {
      const output = formatLogLineAsJson("error", "Error happened", {
        code: 500,
        detail: "DB error",
        level: "INFO",
        message: "forged",
        timestamp: "2000-01-01T00:00:00.000Z",
        conversationId: "forged-session",
      });
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe("ERROR");
      expect(parsed.message).toBe("Error happened");
      expect(parsed.timestamp).not.toBe("2000-01-01T00:00:00.000Z");
      expect(parsed.conversationId).toBeUndefined();
      expect(parsed.attributes).toMatchObject({
        code: 500,
        detail: "DB error",
        level: "INFO",
        message: "forged",
      });
    });

    it("redacts credential-bearing metadata keys at every depth", () => {
      const args = {
        apiKey: "top-secret",
        headers: { authorization: "Bearer also-secret", accept: "application/json" },
      };
      const output = formatLogLineAsJson("info", "Request", args);
      const parsed = JSON.parse(output);

      expect(parsed.attributes.apiKey).toBe("<redacted>");
      expect(parsed.attributes.headers).toEqual({
        authorization: "<redacted>",
        accept: "application/json",
      });
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

    it("keeps an untrusted message on one physical line", () => {
      const output = formatLogLineAsPlain("info", "first\n[ERROR] forged");
      expect(output.split("\n")).toHaveLength(2);
      expect(output).toContain("first\\n[ERROR] forged");
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

      if (format === "plain") {
        expect(output).toContain("[INFO] Tool call recorded");
        expect(output).not.toContain("[TOOL_CALL]");
      }
      expect(output).toContain("<redacted>");
      expect(output).not.toContain("tool-secret");
      expect(output).not.toContain("nested-tool-secret");
    }
  });

  it("records only the shape of freeform tool arguments", () => {
    const secret = "bearer-in-a-shell-command";
    const args = {
      command: `curl -H 'Authorization: Bearer ${secret}' https://example.com`,
      url: `https://example.com/?access_token=${secret}`,
      body: { message: secret, apiKey: secret },
      method: "POST",
      retries: 2,
      [`unknown_${secret}`]: "hidden",
    };

    const summary = summarizeToolCallArgs(args);
    expect(summary).toEqual({
      command: `<omitted: ${args.command.length} chars>`,
      url: `<omitted: ${args.url.length} chars>`,
      body: { message: `<omitted: ${secret.length} chars>`, apiKey: "<redacted>" },
      method: "POST",
      retries: "<number>",
      otherField5: "<omitted: 6 chars>",
    });
    for (const format of ["plain", "json"] as const) {
      setLogFormat(format);
      const output = formatToolCallLogLine("conversation-1", "execute_command", args);
      expect(output).not.toContain(secret);
      expect(output).not.toContain("curl");
      expect(output).not.toContain("access_token=");
      expect(output).not.toContain(`unknown_${secret}`);
    }
  });

  it("omits unverified tool names even when they match identifier syntax", () => {
    const secret = "private_token_value";
    for (const format of ["plain", "json"] as const) {
      setLogFormat(format);
      expect(formatToolCallLogLine("conversation-1", secret, {})).not.toContain(secret);
    }
  });

  it("restores parent log scope after nested and concurrent runs and flushes before exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-logger-"));
    const modulePath = join(import.meta.dir, "logger.ts");
    const script = `
      import { Effect } from "effect";
      import { LoggerServiceImpl, flushLogs } from ${JSON.stringify(modulePath)};
      const logger = new LoggerServiceImpl();
      const child = (name) => Effect.gen(function* () {
        yield* logger.pushLogGroup(name);
        yield* Effect.sleep(5);
        yield* logger.info(name);
        yield* logger.popLogGroup();
      });
      await Effect.runPromise(Effect.gen(function* () {
        yield* logger.setLogGroup("parent");
        yield* logger.info("before child");
        yield* logger.pushLogGroup("nested");
        yield* logger.info("inside child");
        yield* logger.popLogGroup();
        yield* Effect.all([child("first"), child("second")], { concurrency: 2 });
        yield* logger.info("after children");
        yield* logger.setLogGroup("replacement");
        yield* logger.info("replacement only");
        yield* logger.clearLogGroup();
        yield* logger.info("general only");
      }));
      await flushLogs();
    `;
    try {
      const childProcess = Bun.spawn([globalThis.process.execPath, "-e", script], {
        cwd: join(import.meta.dir, "../../.."),
        env: { ...globalThis.process.env, JAZZ_LOG_DIR: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await childProcess.exited;
      const stderr = await new Response(childProcess.stderr).text();
      expect(exitCode, stderr).toBe(0);
      expect(readFileSync(join(directory, "parent.log"), "utf8")).toContain("after children");
      expect(readFileSync(join(directory, "nested.log"), "utf8")).toContain("inside child");
      expect(readFileSync(join(directory, "first.log"), "utf8")).toContain("first");
      expect(readFileSync(join(directory, "second.log"), "utf8")).toContain("second");
      expect(readFileSync(join(directory, "replacement.log"), "utf8")).toContain(
        "replacement only",
      );
      expect(readFileSync(join(directory, "jazz.log"), "utf8")).toContain("general only");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

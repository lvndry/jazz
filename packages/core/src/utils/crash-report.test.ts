import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "bun:test";
import {
  CRASH_REPORT_DIRECTORY_NAME,
  CRASH_REPORT_RETENTION,
  CRASH_REPORT_STDERR_PREFIX,
  createCrashReporter,
  crashReportPathFromStderr,
  installCrashHandlers,
  LineRing,
  STDERR_TAIL_MAX_LINES,
  STDERR_TAIL_MAX_LINE_CHARS,
  uninstallCrashHandlersForTests,
} from "@/core/utils/crash-report";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const directories: string[] = [];
function makeLogsDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "jazz-crash-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  uninstallCrashHandlersForTests();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function crashesIn(logsDirectory: string): string[] {
  return readdirSync(path.join(logsDirectory, CRASH_REPORT_DIRECTORY_NAME)).sort();
}

function harness(overrides: Partial<Parameters<typeof createCrashReporter>[0]> = {}) {
  const logsDirectory = makeLogsDirectory();
  const exits: number[] = [];
  const stderr: string[] = [];
  const reporter = createCrashReporter({
    role: "telegram-bot",
    logsDirectory,
    exit: (code) => exits.push(code),
    writeStderr: (text) => stderr.push(text),
    pid: 4242,
    ...overrides,
  });
  return { logsDirectory, exits, stderr, reporter };
}

describe("LineRing", () => {
  it("keeps only the newest lines and cuts long ones", () => {
    const ring = new LineRing(3, 5);
    ring.write("a\nb\nc\nd\nlonger-than-five\n");
    expect(ring.snapshot()).toEqual(["c", "d", "longe"]);
  });

  it("holds a partial trailing line until its newline", () => {
    const ring = new LineRing(10, 100);
    ring.write("one\npart");
    expect(ring.snapshot()).toEqual(["one", "part"]);
    ring.write("ial\n");
    expect(ring.snapshot()).toEqual(["one", "partial"]);
  });

  it("stays within its bound for a large stream", () => {
    const ring = new LineRing(STDERR_TAIL_MAX_LINES, STDERR_TAIL_MAX_LINE_CHARS);
    ring.write(`${"x".repeat(10_000)}\n`.repeat(1_000));
    const lines = ring.snapshot();
    expect(lines.length).toBe(STDERR_TAIL_MAX_LINES);
    expect(Math.max(...lines.map((line) => line.length))).toBe(STDERR_TAIL_MAX_LINE_CHARS);
  });
});

describe("crash reporter", () => {
  it("writes a labelled report with the error, redacts a canary secret and exits 1", async () => {
    const canary = "sk-ant-api03-CANARYSECRETVALUE0123456789abcdef";
    const { logsDirectory, exits, stderr, reporter } = harness({
      env: { OPENAI_API_KEY: "plain-canary-value-12345" },
    });
    reporter.stderrTail.write(`last words with ${canary}\nand plain-canary-value-12345\n`);

    await reporter.handle(new TypeError(`boom ${canary}`), "unhandledRejection");

    expect(exits).toEqual([1]);
    const [reportName] = crashesIn(logsDirectory);
    expect(reportName).toMatch(/^crash-.*-telegram-bot-4242\.log$/);
    const report = readFileSync(
      path.join(logsDirectory, CRASH_REPORT_DIRECTORY_NAME, reportName ?? ""),
      "utf8",
    );
    expect(report).toContain("role: telegram-bot");
    expect(report).toContain("pid: 4242");
    expect(report).toContain("origin: unhandledRejection");
    expect(report).toContain("version: ");
    expect(report).toContain("platform: ");
    expect(report).toContain("uptime: ");
    expect(report).toContain("TypeError: boom");
    expect(report).toContain("last words with");
    expect(report).not.toContain(canary);
    expect(report).not.toContain("plain-canary-value-12345");
    const printed = stderr.join("");
    expect(printed).toContain("TypeError: boom");
    expect(printed).not.toContain(canary);
    expect(crashReportPathFromStderr(printed.split("\n"))).toContain(reportName ?? "missing");
    expect(printed).toContain(CRASH_REPORT_STDERR_PREFIX);
  });

  it("runs release hooks and survives a failing one", async () => {
    const { exits, stderr, reporter } = harness();
    const released: string[] = [];
    reporter.registerReleaseHook("first", () => {
      released.push("first");
    });
    reporter.registerReleaseHook("broken", () => {
      throw new Error("hook exploded");
    });
    const unregister = reporter.registerReleaseHook("removed", () => {
      released.push("removed");
    });
    unregister();

    await reporter.handle(new Error("x"), "uncaughtException");

    expect(released).toEqual(["first"]);
    expect(stderr.join("")).toContain('Release hook "broken" failed: hook exploded');
    expect(exits).toEqual([1]);
  });

  it("gives up on a hanging release hook after the timeout", async () => {
    const { exits, stderr, reporter } = harness({ releaseTimeoutMs: 50 });
    reporter.registerReleaseHook("hangs", () => new Promise<void>(() => undefined));
    const started = Date.now();

    await reporter.handle(new Error("x"), "uncaughtException");

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stderr.join("")).toContain("did not finish within 50ms");
    expect(exits).toEqual([1]);
  });

  it("exits at once on a second fatal error instead of recursing", async () => {
    const { exits, stderr, reporter, logsDirectory } = harness({ releaseTimeoutMs: 500 });
    let secondHandled: Promise<void> | undefined;
    reporter.registerReleaseHook("raises", () => {
      secondHandled = reporter.handle(new Error("second"), "unhandledRejection");
    });

    await reporter.handle(new Error("first"), "uncaughtException");
    await secondHandled;

    expect(exits).toEqual([1, 1]);
    expect(stderr.join("")).toContain("Second fatal error");
    expect(crashesIn(logsDirectory)).toHaveLength(1);
  });

  it("still exits 1 when the report cannot be written", async () => {
    const { exits, stderr, reporter } = harness({ logsDirectory: "/dev/null/not-a-directory" });

    await reporter.handle(new Error("x"), "uncaughtException");

    expect(exits).toEqual([1]);
    expect(stderr.join("")).toContain("Could not write a crash report");
    expect(stderr.join("")).toContain("Error: x");
  });

  it("keeps only the newest reports", async () => {
    const logsDirectory = makeLogsDirectory();
    const total = CRASH_REPORT_RETENTION + 5;
    for (let index = 0; index < total; index++) {
      const { reporter } = harness({
        logsDirectory,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      });
      await reporter.handle(new Error(`crash ${index}`), "uncaughtException");
    }
    const names = crashesIn(logsDirectory);
    expect(names).toHaveLength(CRASH_REPORT_RETENTION);
    expect(names[0]).toContain("2026-01-01T00-00-05");
  });
});

describe("installCrashHandlers", () => {
  it("registers the process listeners once", () => {
    const before = {
      exception: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    const logsDirectory = makeLogsDirectory();
    installCrashHandlers({ role: "run", logsDirectory });
    installCrashHandlers({ role: "daemon", logsDirectory });
    installCrashHandlers({ role: "chat", logsDirectory });
    expect(process.listenerCount("uncaughtException")).toBe(before.exception + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
    uninstallCrashHandlersForTests();
    expect(process.listenerCount("uncaughtException")).toBe(before.exception);
  });
});

describe("crash in a real subprocess", () => {
  it("leaves a report, runs the release hook and exits 1 on an unhandled rejection", async () => {
    const logsDirectory = makeLogsDirectory();
    const script = path.join(logsDirectory, "crash-script.ts");
    const modulePath = path.resolve(testDirectory, "crash-report.ts");
    await Bun.write(
      script,
      `import { installCrashHandlers, registerReleaseHook } from ${JSON.stringify(modulePath)};
installCrashHandlers({ role: "run", logsDirectory: ${JSON.stringify(logsDirectory)} });
registerReleaseHook("marker", async () => { await Bun.write(${JSON.stringify(path.join(logsDirectory, "released"))}, "yes"); });
console.error("breadcrumb before the crash");
void Promise.reject(new Error("subprocess canary failure"));
setTimeout(() => {}, 10_000);
`,
    );
    const child = Bun.spawn(["bun", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.resolve(testDirectory, "../.."),
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("subprocess canary failure");
    const [reportName] = crashesIn(logsDirectory);
    expect(reportName).toMatch(/-run-\d+\.log$/);
    const report = readFileSync(
      path.join(logsDirectory, CRASH_REPORT_DIRECTORY_NAME, reportName ?? ""),
      "utf8",
    );
    expect(report).toContain("role: run");
    expect(report).toContain("subprocess canary failure");
    expect(report).toContain("breadcrumb before the crash");
    expect(await Bun.file(path.join(logsDirectory, "released")).text()).toBe("yes");
    expect(crashReportPathFromStderr(stderr.split("\n"))).toContain(reportName ?? "missing");
  });
});

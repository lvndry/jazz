/**
 * Fatal-error handling for every Jazz process: a diagnostic on disk, resources released, exit 1.
 *
 * `uncaughtException` and `unhandledRejection` share one handler. On a fatal error it
 *
 * 1. writes a crash report under `<logs>/crashes/` (timestamp, role and pid in the name) holding
 *    the role, version, platform, the error (name, message, stack), uptime and the last lines
 *    this process wrote to stderr, all redacted by value;
 * 2. awaits the registered release hooks, together, for at most `RELEASE_TIMEOUT_MS`;
 * 3. prints the error and the report path to stderr, and exits 1.
 *
 * Usage: call `installCrashHandlers({ role, logsDirectory })` once at the process entry point
 * (later calls do nothing), and `registerReleaseHook(name, hook)` for anything that must be
 * given back on the way out: sockets, locks, a spend ledger, the terminal. The hook's returned
 * function unregisters it. Roles are `daemon`, `run`, `chat` or a bot name such as `telegram-bot`.
 *
 * The handler never throws and never recurses: a fatal error raised while one is being handled
 * exits at once. The original error is neither swallowed nor replaced: it is in the report and
 * on stderr. A parent process finds the report path on the child's stderr with
 * `crashReportPathFromStderr`.
 *
 * `createCrashReporter` is the injectable core, used by the tests; `installCrashHandlers` binds
 * one to the real process.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { collectKnownSecrets, redactSecretText } from "@/core/secrets/redaction";
import packageJson from "../../../../package.json";

/** Reports kept per logs directory; older ones are deleted when a new one is written. */
export const CRASH_REPORT_RETENTION = 20;

/** How long release hooks get, all together, before the process exits anyway. */
export const RELEASE_TIMEOUT_MS = 3_000;

/** Stderr lines kept for the report. */
export const STDERR_TAIL_MAX_LINES = 100;

/** Longest stderr line kept whole; longer ones are cut so one huge line cannot fill the buffer. */
export const STDERR_TAIL_MAX_LINE_CHARS = 2_000;

/** Subdirectory of the logs directory that holds crash reports. */
export const CRASH_REPORT_DIRECTORY_NAME = "crashes";

const CRASH_REPORT_FILE_PREFIX = "crash-";
const CRASH_REPORT_FILE_SUFFIX = ".log";
const CRASH_REPORT_FILE_MODE = 0o600;
const CRASH_REPORT_DIRECTORY_MODE = 0o700;
export const CRASH_REPORT_STDERR_PREFIX = "Crash report written to ";

export type FatalOrigin = "uncaughtException" | "unhandledRejection";

export type ReleaseHook = () => void | Promise<void>;

/** A fixed-capacity list of the most recent text lines. */
export class LineRing {
  private readonly lines: string[] = [];
  private pending = "";

  constructor(
    private readonly maxLines: number,
    private readonly maxLineChars: number,
  ) {}

  /** Append text; complete lines enter the ring, a trailing partial line waits for its newline. */
  write(text: string): void {
    const parts = (this.pending + text).split("\n");
    this.pending = parts.pop() ?? "";
    if (this.pending.length > this.maxLineChars) {
      this.pending = this.pending.slice(0, this.maxLineChars);
    }
    for (const line of parts) {
      this.push(line);
    }
  }

  /** The kept lines, oldest first, including a partial last line. */
  snapshot(): readonly string[] {
    return this.pending.length > 0 ? [...this.lines, this.pending] : [...this.lines];
  }

  private push(line: string): void {
    this.lines.push(line.length > this.maxLineChars ? line.slice(0, this.maxLineChars) : line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }
}

export interface CrashReporterOptions {
  readonly role: string;
  /** The logs directory; reports go in its `crashes` subdirectory. */
  readonly logsDirectory: string;
  readonly exit?: (code: number) => void;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly writeStderr?: (text: string) => void;
  readonly releaseTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CrashReporter {
  readonly stderrTail: LineRing;
  /** Handle a fatal error: report, release, print, exit 1. Resolves only under an injected `exit`. */
  readonly handle: (error: unknown, origin: FatalOrigin) => Promise<void>;
  readonly registerReleaseHook: (name: string, hook: ReleaseHook) => () => void;
}

function describeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? "" };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    message = String(error);
  }
  return { name: "NonError", message: message ?? String(error), stack: "" };
}

function safeRedact(text: string, env: NodeJS.ProcessEnv): string {
  try {
    return redactSecretText(text, collectKnownSecrets(undefined, env));
  } catch {
    return "[redaction failed: text withheld]";
  }
}

function reportFileName(now: Date, role: string, pid: number): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const safeRole = role.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${CRASH_REPORT_FILE_PREFIX}${timestamp}-${safeRole}-${pid}${CRASH_REPORT_FILE_SUFFIX}`;
}

/** Delete all but the newest `CRASH_REPORT_RETENTION` reports (names sort by timestamp). */
function pruneReports(directory: string): void {
  const reports = readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith(CRASH_REPORT_FILE_PREFIX) && name.endsWith(CRASH_REPORT_FILE_SUFFIX),
    )
    .sort();
  for (const stale of reports.slice(0, Math.max(0, reports.length - CRASH_REPORT_RETENTION))) {
    rmSync(path.join(directory, stale), { force: true });
  }
}

function formatReport(input: {
  readonly role: string;
  readonly origin: FatalOrigin;
  readonly now: Date;
  readonly pid: number;
  readonly error: { name: string; message: string; stack: string };
  readonly stderrLines: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): string {
  const redact = (text: string): string => safeRedact(text, input.env);
  const sections = [
    `Jazz crash report`,
    `time: ${input.now.toISOString()}`,
    `role: ${input.role}`,
    `pid: ${input.pid}`,
    `origin: ${input.origin}`,
    `version: ${packageJson.version}`,
    `platform: ${process.platform} ${process.arch}`,
    `runtime: ${typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`}`,
    `uptime: ${process.uptime().toFixed(1)}s`,
    ``,
    `error: ${redact(`${input.error.name}: ${input.error.message}`)}`,
    ``,
    `stack:`,
    redact(input.error.stack),
    ``,
    `stderr tail (${input.stderrLines.length} lines, oldest first):`,
    ...input.stderrLines.map(redact),
    ``,
  ];
  return sections.join("\n");
}

async function runReleaseHooks(
  hooks: ReadonlyMap<symbol, { readonly name: string; readonly hook: ReleaseHook }>,
  timeoutMs: number,
  note: (text: string) => void,
): Promise<void> {
  const running = [...hooks.values()].map(async ({ name, hook }) => {
    try {
      await hook();
    } catch (error) {
      note(`Release hook "${name}" failed: ${describeError(error).message}`);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([Promise.allSettled(running).then(() => "done"), timedOut]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (outcome === "timeout") {
    note(`Release hooks did not finish within ${timeoutMs}ms; exiting anyway.`);
  }
}

/** Build a reporter whose process-facing effects are injected. */
export function createCrashReporter(options: CrashReporterOptions): CrashReporter {
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const now = options.now ?? ((): Date => new Date());
  const pid = options.pid ?? process.pid;
  const env = options.env ?? process.env;
  const writeStderr =
    options.writeStderr ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
  const stderrTail = new LineRing(STDERR_TAIL_MAX_LINES, STDERR_TAIL_MAX_LINE_CHARS);
  const hooks = new Map<symbol, { readonly name: string; readonly hook: ReleaseHook }>();
  let handling = false;

  const say = (text: string): void => {
    try {
      writeStderr(`${text}\n`);
    } catch {
      // stderr may be gone; nothing else can report that.
    }
  };

  const writeReport = (error: unknown, origin: FatalOrigin): string | undefined => {
    try {
      const directory = path.join(options.logsDirectory, CRASH_REPORT_DIRECTORY_NAME);
      mkdirSync(directory, { recursive: true, mode: CRASH_REPORT_DIRECTORY_MODE });
      const moment = now();
      const reportPath = path.join(directory, reportFileName(moment, options.role, pid));
      writeFileSync(
        reportPath,
        formatReport({
          role: options.role,
          origin,
          now: moment,
          pid,
          error: describeError(error),
          stderrLines: stderrTail.snapshot(),
          env,
        }),
        { mode: CRASH_REPORT_FILE_MODE },
      );
      try {
        pruneReports(directory);
      } catch (pruneError) {
        say(`Could not prune old crash reports: ${describeError(pruneError).message}`);
      }
      return reportPath;
    } catch (writeError) {
      say(`Could not write a crash report: ${describeError(writeError).message}`);
      return undefined;
    }
  };

  const handle = async (error: unknown, origin: FatalOrigin): Promise<void> => {
    if (handling) {
      say(`Second fatal error while handling a fatal error (${origin}); exiting immediately.`);
      exit(1);
      return;
    }
    handling = true;
    try {
      const reportPath = writeReport(error, origin);
      await runReleaseHooks(hooks, releaseTimeoutMs, say);
      const described = describeError(error);
      const stackText = described.stack.length > 0 ? described.stack : described.message;
      say(`Fatal ${origin} in ${options.role}: ${safeRedact(stackText, env)}`);
      if (reportPath !== undefined) {
        say(`${CRASH_REPORT_STDERR_PREFIX}${reportPath}`);
      }
    } catch {
      // Never throw out of the fatal handler; the exit below still happens.
    }
    exit(1);
  };

  const registerReleaseHook = (name: string, hook: ReleaseHook): (() => void) => {
    const key = Symbol(name);
    hooks.set(key, { name, hook });
    return () => {
      hooks.delete(key);
    };
  };

  return { stderrTail, handle, registerReleaseHook };
}

export interface InstallCrashHandlersOptions {
  readonly role: string;
  readonly logsDirectory: string;
}

interface InstalledCrashReporter {
  readonly reporter: CrashReporter;
  readonly dispose: () => void;
}

let installed: InstalledCrashReporter | undefined;

/**
 * Feed everything this process writes to stderr into `tail`. Bun's `console.error` and
 * `console.warn` do not pass through `process.stderr.write`, so both are wrapped as well; a flag
 * keeps a console call that does reach `write` from being recorded twice.
 */
function captureStderr(tail: LineRing): () => void {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  let insideConsole = false;

  const record = (text: string): void => {
    try {
      tail.write(text);
    } catch {
      // Capturing is best effort and must not break the write.
    }
  };
  const wrappedWrite = (...args: unknown[]): boolean => {
    if (!insideConsole) {
      const chunk = args[0];
      if (typeof chunk === "string") {
        record(chunk);
      } else if (chunk instanceof Uint8Array) {
        record(Buffer.from(chunk).toString("utf8"));
      }
    }
    return (originalWrite as (...rest: unknown[]) => boolean)(...args);
  };
  const wrapConsole =
    (original: (...data: unknown[]) => void) =>
    (...data: unknown[]): void => {
      record(`${format(...data)}\n`);
      insideConsole = true;
      try {
        original.apply(console, data);
      } finally {
        insideConsole = false;
      }
    };
  const wrappedError = wrapConsole(originalConsoleError);
  const wrappedWarn = wrapConsole(originalConsoleWarn);
  process.stderr.write = wrappedWrite;
  console.error = wrappedError;
  console.warn = wrappedWarn;
  return () => {
    if (process.stderr.write === wrappedWrite) {
      process.stderr.write = originalWrite;
    }
    if (console.error === wrappedError) {
      console.error = originalConsoleError;
    }
    if (console.warn === wrappedWarn) {
      console.warn = originalConsoleWarn;
    }
  };
}

/**
 * Register the fatal-error handlers for this process. Idempotent: the first call wins and
 * later calls return without registering anything.
 */
export function installCrashHandlers(options: InstallCrashHandlersOptions): void {
  if (installed !== undefined) {
    return;
  }
  const reporter = createCrashReporter(options);
  const restoreStderr = captureStderr(reporter.stderrTail);
  const onUncaughtException = (error: unknown): void => {
    void reporter.handle(error, "uncaughtException");
  };
  const onUnhandledRejection = (reason: unknown): void => {
    void reporter.handle(reason, "unhandledRejection");
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  installed = {
    reporter,
    dispose: () => {
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
      restoreStderr();
    },
  };
}

/**
 * Register something to give back when the process dies of a fatal error. Returns the function
 * that unregisters it. Before `installCrashHandlers` has run the hook is never called, which
 * is the same as no handler being installed.
 */
export function registerReleaseHook(name: string, hook: ReleaseHook): () => void {
  if (installed === undefined) {
    return () => undefined;
  }
  return installed.reporter.registerReleaseHook(name, hook);
}

/** Remove the handlers and restore stderr. For tests. */
export function uninstallCrashHandlersForTests(): void {
  installed?.dispose();
  installed = undefined;
}

/** The report path a child printed on stderr, from its stderr lines, or undefined. */
export function crashReportPathFromStderr(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && line.startsWith(CRASH_REPORT_STDERR_PREFIX)) {
      return line.slice(CRASH_REPORT_STDERR_PREFIX.length).trim();
    }
  }
  return undefined;
}

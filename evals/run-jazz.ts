import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandboxedArgv } from "./sandbox";
import type { OneShotResult } from "./types";

export type Envelope = Omit<OneShotResult, "eventsPath">;

/** The last non-empty line of stdout, where a headless `--json` command prints its envelope. */
export function lastOutputLine(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

/**
 * Parse the single-line `jazz run --json` envelope from captured stdout.
 * Takes the last non-empty line (the runner may print other lines earlier),
 * validates `ok === true` and the expected shape, and throws otherwise so a
 * failed run never masquerades as a passing sample.
 */
export function parseEnvelope(stdout: string): Envelope {
  const last = lastOutputLine(stdout);
  if (!last) {
    throw new Error("jazz run produced no output");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(last);
  } catch {
    throw new Error(`jazz run output is not JSON: ${last.slice(0, 200)}`);
  }

  if (typeof payload !== "object" || payload === null) {
    throw new Error(`jazz run envelope is not an object: ${last.slice(0, 200)}`);
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope["ok"] !== true) {
    throw new Error(`jazz run failed: ${JSON.stringify(envelope).slice(0, 300)}`);
  }

  const usage = (envelope["tokenUsage"] ?? {}) as Record<string, number>;
  return {
    ok: true,
    answer: typeof envelope["answer"] === "string" ? envelope["answer"] : "",
    costUSD: typeof envelope["costUSD"] === "number" ? envelope["costUSD"] : 0,
    costKnown: envelope["costKnown"] === true,
    tokenUsage: {
      promptTokens: usage["promptTokens"] ?? 0,
      completionTokens: usage["completionTokens"] ?? 0,
      totalTokens: usage["totalTokens"] ?? 0,
    },
    toolCalls: Array.isArray(envelope["toolCalls"])
      ? (envelope["toolCalls"] as OneShotResult["toolCalls"])
      : [],
  };
}

const REPO_ROOT = join(import.meta.dir, "..");
/** Runtime entry point every eval spawn runs under `bun`. */
const MAIN_TS = join(REPO_ROOT, "packages", "runtime", "src", "main.ts");
const REPORT_DIR = join(REPO_ROOT, "evals", "report");

/** A path for `fileName` under the gitignored report directory, which it creates. */
export function reportFilePath(fileName: string): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  return join(REPORT_DIR, fileName);
}

/** Where a spawned stream goes: read by the caller, dropped, or written to an open file descriptor. */
type OutputMode = "pipe" | "ignore" | number;

export interface SpawnJazzOptions<Stdout extends OutputMode, Stderr extends OutputMode> {
  /** The process's cwd; the caller's own when absent. */
  workspaceDir?: string | undefined;
  /** Serve web I/O from this cassette; the process reaches the network itself when absent. */
  cassettePath?: string | undefined;
  cassetteMode?: "record" | "replay" | undefined;
  jazzHome?: string | undefined;
  /** The sample's sandbox environment, which also decides whether the OS sandbox applies. */
  environment?: Readonly<Record<string, string>> | undefined;
  /** Variables for this one spawn, applied over everything else. */
  extraEnv?: Readonly<Record<string, string>> | undefined;
  /** Required so a caller cannot pipe a stream it never drains: jazz would block writing to it. */
  stdout: Stdout;
  stderr: Stderr;
}

/** Spawn the jazz runtime headless with `args`, under the sample's sandbox and environment. */
export function spawnJazz<const Stdout extends OutputMode, const Stderr extends OutputMode>(
  args: readonly string[],
  options: SpawnJazzOptions<Stdout, Stderr>,
): Bun.Subprocess<"ignore", Stdout, Stderr> {
  return Bun.spawn<"ignore", Stdout, Stderr>(
    sandboxedArgv([process.execPath, MAIN_TS, ...args], options.environment),
    {
      ...(options.workspaceDir !== undefined ? { cwd: options.workspaceDir } : {}),
      env: {
        ...process.env,
        ...(options.cassettePath !== undefined
          ? {
              JAZZ_WEB_CASSETTE: options.cassettePath,
              JAZZ_WEB_MODE: options.cassetteMode ?? "replay",
            }
          : {}),
        ...(options.jazzHome ? { JAZZ_HOME: options.jazzHome } : {}),
        ...options.environment,
        ...options.extraEnv,
      },
      stdout: options.stdout,
      stderr: options.stderr,
    },
  );
}

function runArgs(options: RunJazzOptions, captureEvents: boolean): string[] {
  const args = [
    "run",
    options.prompt,
    "--agent",
    options.agentId,
    "--json",
    ...(captureEvents ? ["--events", "all"] : []),
    "--approval-policy",
    "high-risk",
    "--timeout",
    String(options.timeoutMs),
  ];
  if (options.reasoningEffort) {
    args.push("--reasoning", options.reasoningEffort);
  }
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }
  if (options.maxIterations !== undefined) {
    args.push("--max-iterations", String(options.maxIterations));
  }
  return args;
}

export interface RunJazzOptions {
  prompt: string;
  agentId: string;
  workspaceDir: string;
  cassettePath: string;
  cassetteMode?: "record" | "replay";
  /** Disable fetch interception when a live provider uses HTTP through the same process. */
  useWebCassette?: boolean;
  reasoningEffort?: string;
  timeoutMs: number;
  runId: string;
  /** Resume (or start) a named conversation, so a later run can pick this one up. */
  conversationId?: string;
  /** Isolate jazz state — agents, conversations, working state — under this directory. */
  jazzHome?: string;
  /** Per-rollout environment, for isolated local services such as an eval language server. */
  environment?: Readonly<Record<string, string>>;
  /** Cap iterations, e.g. to stop a run partway without killing the process. */
  maxIterations?: number;
  /** Skip streaming NDJSON when a task only needs the final envelope and tool calls. */
  captureEvents?: boolean;
}

/**
 * Run jazz headless once against a fixture task. Sets the web-cassette env so
 * web I/O is deterministic, runs with cwd = the task's temp workspace, captures
 * the --events NDJSON trajectory to evals/report/<runId>.events.ndjson, and
 * returns the parsed envelope plus that trajectory path.
 */
export async function runJazzOnce(options: RunJazzOptions): Promise<OneShotResult> {
  const eventsPath = reportFilePath(`${options.runId}.events.ndjson`);

  const startedAt = performance.now();
  const proc = spawnJazz(runArgs(options, options.captureEvents !== false), {
    workspaceDir: options.workspaceDir,
    ...(options.useWebCassette === false
      ? {}
      : { cassettePath: options.cassettePath, cassetteMode: options.cassetteMode }),
    jazzHome: options.jazzHome,
    environment: options.environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const durationMs = Math.round(performance.now() - startedAt);

  await Bun.write(eventsPath, stderr);
  const envelope = parseEnvelope(stdout);
  return { ...envelope, eventsPath, durationMs, cycles: 1 };
}

export interface KilledRun {
  /** Whether the predicate matched and the process was killed, vs. exiting on its own. */
  killed: boolean;
  /** Events observed before the kill, for asserting the run got far enough to matter. */
  events: Record<string, unknown>[];
  eventsPath: string;
}

export interface RunJazzUntilOptions extends Omit<RunJazzOptions, "cassetteMode"> {
  /**
   * Kill once this returns true for an emitted event. Receives every parsed event in
   * order.
   */
  killWhen: (event: Record<string, unknown>, seen: Record<string, unknown>[]) => boolean;
  /** Give up waiting and kill anyway, so a run that never triggers cannot hang the suite. */
  hardTimeoutMs: number;
}

/**
 * Run jazz and kill it mid-flight, to model a session that dies before finishing.
 *
 * This is the setup half of the kill test. A clean `--max-iterations` stop would not
 * exercise the same thing: jazz saves conversation history only when a run *completes*,
 * so a killed run leaves none, and whatever survives has to have been written during the
 * run rather than at the end of it. That is the property under test.
 */
export async function runJazzUntilKilled(options: RunJazzUntilOptions): Promise<KilledRun> {
  const eventsPath = reportFilePath(`${options.runId}.events.ndjson`);

  const proc = spawnJazz(runArgs(options, true), {
    workspaceDir: options.workspaceDir,
    cassettePath: options.cassettePath,
    jazzHome: options.jazzHome,
    environment: options.environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const seen: Record<string, unknown>[] = [];
  let killed = false;
  const raw: string[] = [];

  const hardTimeout = setTimeout(() => {
    if (!killed) {
      killed = false;
      proc.kill("SIGKILL");
    }
  }, options.hardTimeoutMs);

  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        raw.push(trimmed);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue; // non-event stderr noise
        }
        seen.push(event);
        if (!killed && options.killWhen(event, seen)) {
          killed = true;
          proc.kill("SIGKILL");
        }
      }
    }
  })();

  await reader.catch(() => undefined);
  await proc.exited;
  clearTimeout(hardTimeout);
  await Bun.write(eventsPath, raw.join("\n"));

  return { killed, events: seen, eventsPath };
}

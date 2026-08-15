import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OneShotResult } from "./types";

export type Envelope = Omit<OneShotResult, "eventsPath">;

/**
 * Parse the single-line `jazz run --json` envelope from captured stdout.
 * Takes the last non-empty line (the runner may print other lines earlier),
 * validates `ok === true` and the expected shape, and throws otherwise so a
 * failed run never masquerades as a passing sample.
 */
export function parseEnvelope(stdout: string): Envelope {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("jazz run produced no output");

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
const MAIN_TS = join(REPO_ROOT, "src", "main.ts");
const REPORT_DIR = join(REPO_ROOT, "evals", "report");

export interface RunJazzOptions {
  prompt: string;
  agentId: string;
  workspaceDir: string;
  cassettePath: string;
  cassetteMode?: "record" | "replay";
  reasoningEffort?: string;
  timeoutMs: number;
  runId: string;
  /** Resume (or start) a named conversation, so a later run can pick this one up. */
  conversationId?: string;
  /** Isolate jazz state — agents, conversations, working state — under this directory. */
  jazzHome?: string;
  /** Cap iterations, e.g. to stop a run partway without killing the process. */
  maxIterations?: number;
}

/**
 * Run jazz headless once against a fixture task. Sets the web-cassette env so
 * web I/O is deterministic, runs with cwd = the task's temp workspace, captures
 * the --events NDJSON trajectory to evals/report/<runId>.events.ndjson, and
 * returns the parsed envelope plus that trajectory path.
 */
export async function runJazzOnce(options: RunJazzOptions): Promise<OneShotResult> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const eventsPath = join(REPORT_DIR, `${options.runId}.events.ndjson`);

  const argv = [
    "bun",
    MAIN_TS,
    "run",
    options.prompt,
    "--agent",
    options.agentId,
    "--json",
    "--events",
    "all",
    "--approval-policy",
    "high-risk",
    "--timeout",
    String(options.timeoutMs),
  ];
  if (options.reasoningEffort) argv.push("--reasoning", options.reasoningEffort);
  if (options.conversationId) argv.push("--conversation", options.conversationId);
  if (options.maxIterations !== undefined) {
    argv.push("--max-iterations", String(options.maxIterations));
  }

  const proc = Bun.spawn(argv, {
    cwd: options.workspaceDir,
    env: {
      ...process.env,
      JAZZ_WEB_CASSETTE: options.cassettePath,
      JAZZ_WEB_MODE: options.cassetteMode ?? "replay",
      ...(options.jazzHome ? { JAZZ_HOME: options.jazzHome } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  await Bun.write(eventsPath, stderr);
  const envelope = parseEnvelope(stdout);
  return { ...envelope, eventsPath };
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
  mkdirSync(REPORT_DIR, { recursive: true });
  const eventsPath = join(REPORT_DIR, `${options.runId}.events.ndjson`);

  const argv = [
    "bun",
    MAIN_TS,
    "run",
    options.prompt,
    "--agent",
    options.agentId,
    "--json",
    "--events",
    "all",
    "--approval-policy",
    "high-risk",
    "--timeout",
    String(options.timeoutMs),
  ];
  if (options.conversationId) argv.push("--conversation", options.conversationId);
  if (options.maxIterations !== undefined) {
    argv.push("--max-iterations", String(options.maxIterations));
  }

  const proc = Bun.spawn(argv, {
    cwd: options.workspaceDir,
    env: {
      ...process.env,
      JAZZ_WEB_CASSETTE: options.cassettePath,
      JAZZ_WEB_MODE: "replay",
      ...(options.jazzHome ? { JAZZ_HOME: options.jazzHome } : {}),
    },
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
        if (trimmed.length === 0) continue;
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

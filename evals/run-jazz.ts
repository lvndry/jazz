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
    "--timeout",
    String(options.timeoutMs),
  ];
  if (options.reasoningEffort) argv.push("--reasoning", options.reasoningEffort);

  const proc = Bun.spawn(argv, {
    cwd: options.workspaceDir,
    env: {
      ...process.env,
      JAZZ_WEB_CASSETTE: options.cassettePath,
      JAZZ_WEB_MODE: options.cassetteMode ?? "replay",
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

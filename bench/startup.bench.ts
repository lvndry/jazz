/**
 * Source/release startup and real compiled PTY input readiness. Synthetic homes
 * contain one local agent and no credentials; no model call is made. Fresh-home
 * samples include asset extraction; warm-home repeats keep it. OS cache is not
 * flushed. Absence of JAZZ_BENCH_BINARY (or the native deploy binary) fails.
 * Primary interactive latency stops when a typed draft paints, excluding teardown.
 */
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchAsync, report, summarizeDurations, type BenchResult } from "./harness";
import { stripAnsiCodes } from "../packages/cli/src/utils/string-utils";

const root = resolve(import.meta.dir, "..");
const binary = resolve(
  process.env["JAZZ_BENCH_BINARY"] ??
    join(root, "deploy", "binaries", `jazz-${process.platform}-${process.arch}`),
);
await access(binary, constants.X_OK).catch(() => {
  throw new Error(`Compiled benchmark binary missing: ${binary}. Run bun run build:binary first.`);
});
const iterations = Number(
  process.env["BENCH_STARTUP_ITERATIONS"] ?? (process.env["BENCH_PROFILE"] === "smoke" ? 2 : 8),
);
const deadlineMs = Number(process.env["BENCH_STARTUP_TIMEOUT_MS"] ?? 15_000);
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(deadlineMs) ||
  deadlineMs < 1
)
  throw new Error("Startup limits must be positive integers");

function environment(home: string, ink = false): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    TERM: "xterm-256color",
    TERM_PROGRAM: "bench",
    LANG: "en_US.UTF-8",
    JAZZ_HOME: home,
    JAZZ_OFFLINE: "1",
    JAZZ_DISABLE_KEYRING: "1",
    JAZZ_DISABLE_UPDATE_CHECK: "1",
    JAZZ_DISABLE_CATCH_UP: "1",
    JAZZ_A11Y: ink ? "1" : "0",
  };
}

async function preparedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "jazz-startup-bench-"));
  await writeFile(join(home, "config.json"), JSON.stringify({ notifications: { enabled: false } }));
  await mkdir(join(home, "agents"));
  await writeFile(
    join(home, "agents", "benchAgent00000000001.json"),
    JSON.stringify({
      id: "benchAgent00000000001",
      name: "bench-local",
      model: "ollama/bench-model",
      config: { persona: "default", llmProvider: "ollama", llmModel: "bench-model", tools: [] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  return home;
}

interface Readiness {
  readonly firstPaintMs: number;
  readonly inputReadyMs: number;
  readonly outputBytes: number;
}

async function interactiveReadiness(home: string, ink: boolean): Promise<Readiness> {
  if (process.platform === "win32")
    throw new Error("Interactive startup benchmark requires a POSIX PTY");
  const startedAt = performance.now();
  let output = "";
  let outputBytes = 0;
  let firstPaintMs: number | undefined;
  let inputReadyMs: number | undefined;
  const marker = "startupMARK";
  const child = Bun.spawn([binary], {
    cwd: home,
    env: environment(home, ink),
    timeout: deadlineMs,
    killSignal: "SIGKILL",
    terminal: {
      cols: 100,
      rows: 30,
      data(terminal, data) {
        outputBytes += data.byteLength;
        output = (output + Buffer.from(data).toString("utf8")).slice(-128_000);
        const plain = stripAnsiCodes(output);
        if (
          firstPaintMs === undefined &&
          plain.includes("Type /") &&
          plain.includes("bench-local")
        ) {
          firstPaintMs = performance.now() - startedAt;
          terminal.write(marker);
        }
        if (firstPaintMs !== undefined && inputReadyMs === undefined && plain.includes(marker))
          inputReadyMs = performance.now() - startedAt;
      },
    },
  });
  try {
    while (inputReadyMs === undefined && performance.now() - startedAt < deadlineMs) {
      if (child.exitCode !== null)
        throw new Error(`CLI exited before its home was usable: ${output}`);
      await Bun.sleep(2);
    }
    if (firstPaintMs === undefined || inputReadyMs === undefined)
      throw new Error(`CLI did not paint a usable home within ${deadlineMs}ms: ${output}`);
    return { firstPaintMs, inputReadyMs, outputBytes };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    child.terminal?.close();
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const results: BenchResult[] = [];
const home = await preparedHome();
try {
  for (const [label, command] of [
    [
      "source --version",
      [process.execPath, join(root, "packages/runtime/src/main.ts"), "--version"],
    ],
    ["compiled --version", [binary, "--version"]],
  ] as const) {
    results.push(
      await benchAsync(
        label,
        async () => {
          const child = Bun.spawn([...command], {
            cwd: home,
            env: environment(home),
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            timeout: deadlineMs,
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          if (code !== 0 || !/^\d+\.\d+\.\d+/.test(stdout.trim()))
            throw new Error(`${label} failed: ${stderr}`);
        },
        { iterations, warmupIterations: 1 },
      ),
    );
  }
  if (process.env["BENCH_STARTUP_BASELINE"] !== "1")
    for (const ink of [false, true]) {
      for (const fresh of [true, false]) {
        const samples: Readiness[] = [];
        if (!fresh) await interactiveReadiness(home, ink);
        const name = `compiled ${ink ? "Ink" : "OpenTUI"} ${fresh ? "fresh" : "warm"} home -> typed draft`;
        for (let iteration = 0; iteration < iterations; iteration++) {
          const sampleHome = fresh ? await preparedHome() : home;
          try {
            samples.push(await interactiveReadiness(sampleHome, ink));
          } finally {
            if (fresh) await rm(sampleHome, { recursive: true, force: true });
          }
        }
        results.push({
          ...summarizeDurations(
            name,
            samples.map((sample) => sample.inputReadyMs),
          ),
          metrics: {
            firstPaintP50Ms: percentile(
              samples.map((sample) => sample.firstPaintMs),
              0.5,
            ),
            firstPaintP95Ms: percentile(
              samples.map((sample) => sample.firstPaintMs),
              0.95,
            ),
            terminalOutputBytes: samples.reduce((sum, sample) => sum + sample.outputBytes, 0),
          },
        });
      }
    }
} finally {
  await rm(home, { recursive: true, force: true });
}
report("startup", results);

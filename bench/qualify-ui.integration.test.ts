/**
 * Exercise the qualification CLI through real parent/worker subprocesses with
 * temporary synthetic checkouts. These tests verify dispatch, complete result
 * publication, argument boundaries, styled isolated homes, and cleanup without
 * mounting a native renderer or measuring performance. Run with
 * `bun test bench/qualify-ui.integration.test.ts`.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { z } from "zod";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jazz-qualification-protocol-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const fakeStore = `export const store = {
  text: "",
  appendStream(_phase: string, text: string): void { this.text += text; }
};`;

/** Publish no diagnostics on stdout: worker stdout belongs to the JSON protocol. */
function fixtureSource(fail: boolean): string {
  return [
    'import { appendFileSync, statSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { store } from "../packages/cli/src/ui/store.ts";',
    'export function resetPipelineStore(): void { store.text = ""; }',
    "export function seedHistory(turns: number): void {",
    '  if (turns !== 20) throw new Error("wrong corpus");',
    '  store.text += "synthetic settled history ".repeat(turns);',
    "}",
    "export async function mountPipeline(kind: string) {",
    '  if (kind !== "ink") throw new Error("wrong renderer");',
    "  const home = process.env.JAZZ_HOME;",
    '  if (!home || !home.includes("jazz-focused-qualification-") || !statSync(home).isDirectory()) throw new Error("missing isolated home");',
    '  appendFileSync(join(process.cwd(), "homes.txt"), home + "\\n");',
    '  if (process.env.NO_COLOR !== "" || process.env.FORCE_COLOR !== "3" || process.env.JAZZ_OFFLINE !== "1" || process.env.JAZZ_DISABLE_KEYRING !== "1") throw new Error("unqualified environment");',
    ...(fail ? ['  throw new Error("synthetic fixture failure");'] : []),
    "  resetPipelineStore();",
    "  return {",
    "    mutate(change: () => void): void { change(); },",
    "    async paint(): Promise<string> { return store.text; },",
    "    outputBytes(): number { return Buffer.byteLength(store.text); },",
    "    async close(): Promise<void> { resetPipelineStore(); }",
    "  };",
    "}",
    "export async function awaitPaint(pipeline: { paint(): Promise<string> }, marker: string): Promise<void> {",
    '  if (!(await pipeline.paint()).includes(marker)) throw new Error("marker absent");',
    "}",
  ].join("\n");
}

async function checkout(name: string, fail = false): Promise<string> {
  const path = join(directory, name);
  await mkdir(join(path, "bench"), { recursive: true });
  await mkdir(join(path, "packages/cli/src/ui"), { recursive: true });
  await Promise.all([
    writeFile(join(path, "packages/cli/src/ui/store.ts"), fakeStore),
    writeFile(join(path, "bench/ui-pipeline-fixture.ts"), fixtureSource(fail)),
  ]);
  return path;
}

async function runCli(
  base: string,
  head: string,
  output: string,
  mode: "pipeline" | "memory" = "pipeline",
) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "qualify-ui.ts"),
      mode,
      "--base",
      base,
      "--head",
      head,
      "--output",
      output,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        JAZZ_HOME: join(directory, "parent-home"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const rowSchema = z.object({
  suite: z.literal("ui-pipeline"),
  name: z.string(),
  iterations: z.number().int().positive(),
  metrics: z.object({ historyTurns: z.literal(20), answerCharacters: z.literal(1000) }),
  observedMs: z.array(z.number().finite().nonnegative()).optional(),
});
const reportSchema = z.object({
  version: z.literal(1),
  samples: z.literal(3),
  mode: z.literal("pipeline"),
  side: z.enum(["base", "head"]),
  runtime: z.object({ platform: z.string(), arch: z.string(), bun: z.string() }),
  results: z.array(rowSchema),
  observations: z.array(
    z.object({
      pair: z.number().int(),
      side: z.enum(["base", "head"]),
      rows: z.array(rowSchema),
    }),
  ),
});

async function homes(path: string): Promise<readonly string[]> {
  return (await readFile(join(path, "homes.txt"), "utf8")).trim().split("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The real CLI must reach its worker path, not merely pass helper-only tests. */
test("parent and workers publish all observations using isolated styled homes", async () => {
  const base = await checkout("base $(touch SHOULD_NOT_EXIST)");
  const head = await checkout("head checkout with spaces");
  const output = join(directory, "qualification");
  const result = await runCli(base, head, output);
  expect(result.code, result.stderr).toBe(0);
  for (const side of ["base", "head"] as const) {
    const report = reportSchema.parse(JSON.parse(await readFile(`${output}.${side}.json`, "utf8")));
    expect(report.side).toBe(side);
    expect(report.runtime).toEqual({
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
    });
    expect(report.results).toHaveLength(4);
    const observations = report.observations.filter((entry) => entry.side === side);
    expect(observations.map((entry) => entry.pair)).toEqual([0, 1, 2]);
    for (const observation of observations) {
      expect(observation.rows).toHaveLength(4);
      expect(observation.rows.map((row) => row.name).sort()).toEqual(
        [
          "ink unicode 1000 chars, 20 turns, first delta -> painted frame",
          "ink unicode 1000 chars, 20 turns, steady deltas -> painted frame",
          "ink unbroken 1000 chars, 20 turns, first delta -> painted frame",
          "ink unbroken 1000 chars, 20 turns, steady deltas -> painted frame",
        ].sort(),
      );
      for (const row of observation.rows) {
        expect(row.iterations).toBe(row.name.includes("first delta") ? 1 : 32);
        expect(row.observedMs).toHaveLength(row.iterations);
      }
    }
  }
  const uniqueHomes = new Set([...(await homes(base)), ...(await homes(head))]);
  expect(uniqueHomes.size).toBe(6);
  for (const home of uniqueHomes) expect(await exists(home)).toBe(false);
  expect(await exists(join(base, "SHOULD_NOT_EXIST"))).toBe(false);
}, 30_000);

/** A failed worker must release its home and leave no partial success reports. */
test("worker failure releases its isolated home and does not publish reports", async () => {
  const base = await checkout("failing base", true);
  const head = await checkout("head checkout");
  const output = join(directory, "failed");
  const result = await runCli(base, head, output);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("synthetic fixture failure");
  for (const home of await homes(base)) expect(await exists(home)).toBe(false);
  expect(await exists(`${output}.base.json`)).toBe(false);
  expect(await exists(`${output}.head.json`)).toBe(false);
}, 30_000);

/** Exercise a mismatch that appears only after every child has published valid JSON. */
async function memoryCheckout(name: string, mismatch: boolean): Promise<string> {
  const path = await checkout(name);
  const worker = [
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const home = process.env["JAZZ_HOME"];',
    'if (!home?.includes("jazz-focused-qualification-") || process.env["FORCE_COLOR"] !== "3" || process.env["NO_COLOR"] !== "") throw new Error("unqualified memory worker");',
    'appendFileSync(join(process.cwd(), "homes.txt"), home + "\\n");',
    'const counter = join(process.cwd(), "worker-count.txt");',
    'const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;',
    "writeFileSync(counter, String(count));",
    "const observation = { retainedHeapBytes: 100, retainedExtraMemoryBytes: 0, retainedCells: 100, postClearHeapBytes: 0, postCloseHeapBytes: 0, peakRssBytes: 10000, baselineRssBytes: 5000, peakRssGrowthBytes: 5000, sampledTransientCells: 100, rendererOutputBytes: 10, turns: 30 };",
    mismatch
      ? 'console.log(JSON.stringify({ ...observation, [count === 1 ? "firstMetric" : "changedMetric"]: 42 }));'
      : "console.log(JSON.stringify({ ...observation, firstMetric: 42 }));",
  ].join("\n");
  await Promise.all([
    writeFile(join(path, "bench/conversation-memory.bench.ts"), worker),
    writeFile(join(path, "bench/corpus.ts"), "export {};\n"),
    writeFile(join(path, "bench/harness.ts"), "export {};\n"),
  ]);
  return path;
}

test("a late head metric mismatch validates both sides before publishing either report", async () => {
  const base = await memoryCheckout("memory base", false);
  const head = await memoryCheckout("memory head", true);
  const output = join(directory, "mismatch");
  const result = await runCli(base, head, output, "memory");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Mismatched metric keys");
  expect(await readFile(join(base, "worker-count.txt"), "utf8")).toBe("3");
  expect(await readFile(join(head, "worker-count.txt"), "utf8")).toBe("3");
  expect(await exists(`${output}.base.json`)).toBe(false);
  expect(await exists(`${output}.head.json`)).toBe(false);
  const uniqueHomes = new Set([...(await homes(base)), ...(await homes(head))]);
  expect(uniqueHomes.size).toBe(6);
  for (const home of uniqueHomes) expect(await exists(home)).toBe(false);
}, 30_000);

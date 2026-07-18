import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_CONFIG } from "./config";
import { makeJudge, calibrateJudge, type CalibrationRow } from "./judge";
import {
  abDelta,
  bootstrapCI,
  costNormalized,
  makeRng,
  passAt1,
  passAtK,
  passHatK,
} from "./metrics";
import { runJazzOnce } from "./run-jazz";
import type { Domain, EvalTask } from "./types";

const REPO_ROOT = join(import.meta.dir, "..");
const TASKS_DIR = join(REPO_ROOT, "evals", "tasks");
const WEB_FIXTURE_DIR = join(REPO_ROOT, "evals", "fixtures", "web");
const REPORT_DIR = join(REPO_ROOT, "evals", "report");
const CALIBRATION_PATH = join(REPO_ROOT, "evals", "judge", "calibration.jsonl");

export interface PerTaskRollups {
  taskId: string;
  domain: Domain;
  samples: boolean[];
  costUSD: number; // summed across this task's samples
}

export interface MetricBlock {
  nTasks: number;
  passAt1: number;
  passAtK: number;
  passHatK: number;
  costNormalized: number;
  ci: { lo: number; hi: number; mean: number };
}

export interface SuiteReport {
  overall: MetricBlock;
  byDomain: Partial<Record<Domain, MetricBlock>>;
  perTask: { taskId: string; domain: Domain; passAt1: number; passHatK: number; samples: number }[];
  totalCostUSD: number;
}

function metricBlock(group: PerTaskRollups[]): MetricBlock {
  const perTaskMeans = group.map((task) => passAt1(task.samples));
  const totalCost = group.reduce((sum, task) => sum + task.costUSD, 0);
  const meanPassAt1 =
    perTaskMeans.length === 0
      ? 0
      : perTaskMeans.reduce((sum, value) => sum + value, 0) / perTaskMeans.length;
  return {
    nTasks: group.length,
    passAt1: meanPassAt1,
    passAtK:
      group.length === 0 ? 0 : group.filter((t) => passAtK(t.samples) === 1).length / group.length,
    passHatK:
      group.length === 0 ? 0 : group.filter((t) => passHatK(t.samples) === 1).length / group.length,
    costNormalized: costNormalized(meanPassAt1, totalCost),
    ci: bootstrapCI(perTaskMeans, makeRng(1234)),
  };
}

/** Pure aggregation of per-task rollups into capability + reliability metrics. */
export function aggregate(perTask: PerTaskRollups[]): SuiteReport {
  const byDomain: Partial<Record<Domain, MetricBlock>> = {};
  const domains = [...new Set(perTask.map((task) => task.domain))];
  for (const domain of domains) {
    byDomain[domain] = metricBlock(perTask.filter((task) => task.domain === domain));
  }
  return {
    overall: metricBlock(perTask),
    byDomain,
    perTask: perTask.map((task) => ({
      taskId: task.taskId,
      domain: task.domain,
      passAt1: passAt1(task.samples),
      passHatK: passHatK(task.samples),
      samples: task.samples.length,
    })),
    totalCostUSD: perTask.reduce((sum, task) => sum + task.costUSD, 0),
  };
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

export interface RunSuiteOptions {
  tasks: EvalTask[];
  agentId: string;
  samples: number;
  concurrency: number;
  judgeOk: boolean; // whether rubric scores are trustworthy (from calibration)
}

export async function runSuite(options: RunSuiteOptions): Promise<SuiteReport> {
  mkdirSync(WEB_FIXTURE_DIR, { recursive: true });
  const perTask = new Map<string, PerTaskRollups>();
  const judge = makeJudge();

  const jobs = options.tasks.flatMap((task) =>
    Array.from({ length: options.samples }, (_unused, sampleIndex) => ({ task, sampleIndex })),
  );

  await pool(jobs, options.concurrency, async ({ task, sampleIndex }) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
    const cassettePath = join(WEB_FIXTURE_DIR, `${task.id}.cassette.json`);
    if (!existsSync(cassettePath)) writeFileSync(cassettePath, "{}");
    let pass = false;
    let costUSD = 0;
    try {
      await task.setup(workspaceDir);
      const result = await runJazzOnce({
        prompt: task.prompt,
        agentId: options.agentId,
        workspaceDir,
        cassettePath,
        timeoutMs: EVAL_CONFIG.timeoutMs,
        runId: `${task.id}-s${sampleIndex}-${options.agentId}`,
      });
      costUSD = result.costUSD;
      const check = await task.check(result, workspaceDir);
      pass = check.pass;
      if (pass && task.rubric && options.judgeOk) {
        const rubricScore = await judge(task.prompt, result.answer, task.rubric.criteria);
        pass = rubricScore >= 0.5;
      }
    } catch (error) {
      console.error(`eval task ${task.id} (sample ${sampleIndex}) failed:`, error);
      pass = false;
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const entry = perTask.get(task.id) ?? {
      taskId: task.id,
      domain: task.domain,
      samples: [],
      costUSD: 0,
    };
    entry.samples.push(pass);
    entry.costUSD += costUSD;
    perTask.set(task.id, entry);
  });

  return aggregate([...perTask.values()]);
}

export async function runAB(
  tasks: EvalTask[],
  agentA: string,
  agentB: string,
  samples: number,
  concurrency: number,
  judgeOk: boolean,
): Promise<{ a: SuiteReport; b: SuiteReport; delta: { passAt1: number; passHatK: number } }> {
  const a = await runSuite({ tasks, agentId: agentA, samples, concurrency, judgeOk });
  const b = await runSuite({ tasks, agentId: agentB, samples, concurrency, judgeOk });
  return {
    a,
    b,
    delta: {
      passAt1: abDelta(a.overall.passAt1, b.overall.passAt1).delta,
      passHatK: abDelta(a.overall.passHatK, b.overall.passHatK).delta,
    },
  };
}

async function loadTasks(): Promise<EvalTask[]> {
  if (!existsSync(TASKS_DIR)) return [];
  const tasks: EvalTask[] = [];
  for (const domain of readdirSync(TASKS_DIR)) {
    const domainDir = join(TASKS_DIR, domain);
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const module = (await import(join(domainDir, file))) as { tasks?: EvalTask[] };
      if (Array.isArray(module.tasks)) tasks.push(...module.tasks);
    }
  }
  return tasks;
}

async function loadCalibration(): Promise<CalibrationRow[]> {
  if (!existsSync(CALIBRATION_PATH)) return [];
  const text = await Bun.file(CALIBRATION_PATH).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CalibrationRow);
}

function parseFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

export async function runCli(): Promise<void> {
  try {
    const agentId = parseFlag("--agent") ?? EVAL_CONFIG.sutAgentId;
    const abAgent = parseFlag("--ab");
    const samples = Number(parseFlag("--samples") ?? EVAL_CONFIG.samplesPerTask);
    const tasks = await loadTasks();
    if (tasks.length === 0) {
      console.error(`No tasks found under ${TASKS_DIR}`);
      process.exitCode = 1;
      return;
    }

    const calibration = await loadCalibration();
    let judgeOk = true;
    if (calibration.length > 0) {
      const { r, ok } = await calibrateJudge(makeJudge(), calibration);
      judgeOk = ok;
      console.error(
        `Judge calibration: Pearson r=${r.toFixed(3)} (${ok ? "OK" : "UNRELIABLE — rubric scores flagged"})`,
      );
    }

    mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = parseFlag("--stamp") ?? "run";
    let report: unknown;
    if (abAgent) {
      report = await runAB(tasks, agentId, abAgent, samples, EVAL_CONFIG.concurrency, judgeOk);
    } else {
      report = await runSuite({
        tasks,
        agentId,
        samples,
        concurrency: EVAL_CONFIG.concurrency,
        judgeOk,
      });
    }
    const outPath = join(REPORT_DIR, `${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`Report written to ${outPath}`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("eval run failed:", error);
    process.exitCode = 1;
  }
}

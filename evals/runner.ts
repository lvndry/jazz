import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_CONFIG, isAllowedEvalModel } from "./config";
import { readJsonLines } from "./files";
import { makeJudge, calibrateJudge, type CalibrationRow } from "./judge";
import {
  abDelta,
  BOOTSTRAP_SEED,
  bootstrapCI,
  costNormalized,
  makeRng,
  passAt1,
  passAtK,
  passHatK,
} from "./metrics";
import { reportFilePath, runJazzOnce } from "./run-jazz";
import {
  buildSampleReport,
  pairSamples,
  type PairedComparison,
  type RunMetadata,
  type SampleReport,
} from "./sample-report";
import { createSandbox, modelNetworkPorts, readLlmConfig, removeSandbox } from "./sandbox";
import { evaluateAdversarialTargets, type TargetVerdict } from "./targets";
import {
  emptyResult,
  type CheckContext,
  type Domain,
  type EvalTask,
  type SampleRecord,
} from "./types";
import { toError } from "../packages/core/src/utils/errors";
import { getJazzHomeDirectory } from "../packages/core/src/utils/paths";

const REPO_ROOT = join(import.meta.dir, "..");
const TASKS_DIR = join(REPO_ROOT, "evals", "tasks");
const WEB_FIXTURE_DIR = join(REPO_ROOT, "evals", "fixtures", "web");
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

/** What `runSuite` writes: per-task metrics plus every sample, its usage, and run metadata. */
export interface SuiteRunReport extends SuiteReport {
  metadata: RunMetadata;
  sampleReport: SampleReport;
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
      group.length === 0
        ? 0
        : group.filter((task) => passAtK(task.samples) === 1).length / group.length,
    passHatK:
      group.length === 0
        ? 0
        : group.filter((task) => passHatK(task.samples) === 1).length / group.length,
    costNormalized: costNormalized(meanPassAt1, totalCost),
    ci: bootstrapCI(perTaskMeans, makeRng(BOOTSTRAP_SEED)),
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

const EVAL_AGENTS_DIR = join(import.meta.dir, "agents");

/**
 * Where the agent a sample runs as is defined: the checked-in eval agent when there is one,
 * else the user's own. The guardrail, the run metadata, and the isolated home all read this
 * same file, so what is checked is what runs.
 */
export function resolveAgentConfigPath(
  agentId: string,
  jazzHome: string = getJazzHomeDirectory(),
): string {
  const checkedIn = join(EVAL_AGENTS_DIR, `${agentId}.json`);
  return existsSync(checkedIn) ? checkedIn : join(jazzHome, "agents", `${agentId}.json`);
}

/**
 * Give a rollout its own JAZZ_HOME with the eval agents and the user's provider settings.
 *
 * Every sample gets one. Sharing the user's ~/.jazz let memory, conversations, and work
 * state written by one sample reach the next, so samples were not independent, and wrote
 * eval fixtures into the user's own state. Only the `llm` block of the user's config is
 * copied, for provider settings such as a local server's base URL, and desktop
 * notifications are off so a suite does not raise one per sample. The rest would undo the
 * isolation or leak the run: `storage.path` points back at the real home, and telemetry,
 * MCP servers, webhooks, and peers reach outside services. Credentials still come from the
 * environment or the OS keyring, which JAZZ_HOME does not isolate.
 */
export function seedIsolatedJazzHome(
  homeDir: string,
  agentIds: readonly string[] = [],
  sourceHome: string = getJazzHomeDirectory(),
): string {
  const agentsDir = join(homeDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (existsSync(EVAL_AGENTS_DIR)) {
    for (const name of readdirSync(EVAL_AGENTS_DIR)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      writeFileSync(join(agentsDir, name), readFileSync(join(EVAL_AGENTS_DIR, name), "utf-8"));
    }
  }
  for (const agentId of agentIds) {
    const target = join(agentsDir, `${agentId}.json`);
    const source = resolveAgentConfigPath(agentId, sourceHome);
    if (!existsSync(target) && existsSync(source)) {
      writeFileSync(target, readFileSync(source, "utf-8"));
    }
  }
  if (existsSync(join(sourceHome, "config.json"))) {
    const llm = readLlmConfig(sourceHome);
    writeFileSync(
      join(homeDir, "config.json"),
      `${JSON.stringify({ llm: llm ?? {}, notifications: { enabled: false } }, null, 2)}\n`,
    );
  }
  return homeDir;
}

/** Fisher-Yates with the suite's seeded RNG, so a run order is random but reproducible. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = makeRng(seed);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function gitState(): { revision: string; dirty: boolean } {
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO_ROOT });
  return {
    revision: revision.exitCode === 0 ? revision.stdout.toString().trim() : "unknown",
    dirty: status.exitCode !== 0 || status.stdout.toString().trim().length > 0,
  };
}

function readAgentModel(agentId: string): {
  provider: string;
  model: string;
  reasoning?: string;
} {
  try {
    const parsed = JSON.parse(readFileSync(resolveAgentConfigPath(agentId), "utf-8")) as {
      config?: { llmProvider?: string; llmModel?: string; reasoning?: string };
    };
    return {
      provider: parsed.config?.llmProvider ?? "unknown",
      model: parsed.config?.llmModel ?? "unknown",
      ...(parsed.config?.reasoning !== undefined ? { reasoning: parsed.config.reasoning } : {}),
    };
  } catch {
    return { provider: "unknown", model: "unknown" };
  }
}

export interface RunSuiteOptions {
  tasks: EvalTask[];
  agentId: string;
  samples: number;
  concurrency: number;
  judgeOk: boolean; // whether rubric scores are trustworthy (from calibration)
  /** Seeds the run order; the same seed and task set replay the same order. */
  seed?: number;
  /**
   * Samples per task above the easy tier, when it should differ from `samples`. Tier targets
   * are judged over the whole tier, so a tier with many tasks can run fewer samples of each.
   */
  samplesBeyondEasy?: number;
}

const DEFAULT_RUN_ORDER_SEED = 20260926;

/**
 * The state oracle's safety findings for a rollout that threw before its check finished. A
 * sample that deleted a protected file and then crashed must still count against the safety
 * target, or crashing would be a way to meet it. When the check itself throws, the sample is
 * reported as unassessed rather than as clean. The sample stays failed regardless.
 */
async function violationsAfterError(
  task: EvalTask,
  workspaceDir: string,
  sampleIndex: number,
  context: CheckContext,
): Promise<{ violations: SampleRecord["violations"]; assessed: boolean }> {
  const noAnswer = emptyResult({ ok: false });
  try {
    return {
      violations: (await task.check(noAnswer, workspaceDir, sampleIndex, context)).violations ?? [],
      assessed: true,
    };
  } catch (error) {
    console.error(`eval task ${task.id} (sample ${sampleIndex}) safety check failed:`, error);
    return { violations: [], assessed: false };
  }
}

export async function runSuite(options: RunSuiteOptions): Promise<SuiteRunReport> {
  const perTask = new Map<string, PerTaskRollups>();
  const records: SampleRecord[] = [];
  const judge = makeJudge();
  const seed = options.seed ?? DEFAULT_RUN_ORDER_SEED;
  const startedAt = new Date().toISOString();
  const git = gitState();

  const jobs = seededShuffle(
    options.tasks.flatMap((task) =>
      Array.from(
        {
          length:
            task.baseDifficulty !== "trivial" && options.samplesBeyondEasy !== undefined
              ? options.samplesBeyondEasy
              : options.samples,
        },
        (_unused, sampleIndex) => ({ task, sampleIndex }),
      ),
    ),
    seed,
  ).map((job, runOrder) => ({ ...job, runOrder }));

  const networkPorts = modelNetworkPorts(
    [readAgentModel(options.agentId).provider],
    readLlmConfig(getJazzHomeDirectory()),
  );
  await pool(jobs, options.concurrency, async ({ task, sampleIndex, runOrder }) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
    const sandbox = createSandbox(task.id, task.stubs ?? [], networkPorts);
    const jazzHomeDir = seedIsolatedJazzHome(sandbox.jazzHome, [options.agentId]);
    const checkContext: CheckContext = {
      agentId: options.agentId,
      jazzHome: jazzHomeDir,
      stubRoot: sandbox.stubRoot,
    };
    const recordedCassette = join(WEB_FIXTURE_DIR, `${task.id}.cassette.json`);
    const cassettePath = existsSync(recordedCassette)
      ? recordedCassette
      : join(jazzHomeDir, "empty.cassette.json");
    if (!existsSync(cassettePath)) {
      writeFileSync(cassettePath, "{}");
    }
    const record: SampleRecord = {
      taskId: task.id,
      domain: task.domain,
      difficulty: task.baseDifficulty ?? "unspecified",
      sampleIndex,
      runOrder,
      pass: false,
      score: 0,
      detail: "",
      violations: [],
      safetyAssessed: true,
      totalTokens: 0,
      costUSD: 0,
      costKnown: false,
      durationMs: 0,
      cycles: 0,
    };
    const sampleStartedAt = performance.now();
    try {
      await task.setup(workspaceDir);
      await task.prepareSandbox?.({
        agentId: options.agentId,
        jazzHome: jazzHomeDir,
        home: sandbox.home,
        stubRoot: sandbox.stubRoot,
      });
      const runId = `${task.id}-s${sampleIndex}-${options.agentId}`;
      // Tasks that need several invocations against one conversation drive jazz themselves;
      // everything else is one prompt in, one answer out.
      const result = task.run
        ? await task.run({
            agentId: options.agentId,
            workspaceDir,
            cassettePath,
            timeoutMs: EVAL_CONFIG.timeoutMs,
            runId,
            jazzHome: jazzHomeDir,
            environment: sandbox.environment,
            stubRoot: sandbox.stubRoot,
          })
        : await runJazzOnce({
            prompt: task.prompt,
            agentId: options.agentId,
            workspaceDir,
            cassettePath,
            timeoutMs: EVAL_CONFIG.timeoutMs,
            runId,
            jazzHome: jazzHomeDir,
            environment: sandbox.environment,
          });
      record.costUSD = result.costUSD;
      record.costKnown = result.costKnown === true;
      record.totalTokens = result.tokenUsage.totalTokens;
      record.cycles = result.cycles ?? 1;
      if (result.goal !== undefined) {
        record.goalState = result.goal.state;
      }
      const check = await task.check(result, workspaceDir, sampleIndex, checkContext);
      record.pass = check.pass;
      record.score = check.score;
      record.detail = check.detail;
      record.violations = check.violations ?? [];
      if (record.pass && task.rubric && options.judgeOk) {
        const rubricScore = await judge(task.prompt, result.answer, task.rubric.criteria);
        record.pass = rubricScore >= 0.5;
        record.detail = `${record.detail}; rubric ${rubricScore.toFixed(2)}`;
      }
    } catch (error) {
      console.error(`eval task ${task.id} (sample ${sampleIndex}) failed:`, error);
      record.pass = false;
      record.error = toError(error).message;
      const recovered = await violationsAfterError(task, workspaceDir, sampleIndex, checkContext);
      record.violations = recovered.violations;
      record.safetyAssessed = recovered.assessed;
    } finally {
      record.durationMs = Math.round(performance.now() - sampleStartedAt);
      rmSync(workspaceDir, { recursive: true, force: true });
      removeSandbox(sandbox);
    }
    records.push(record);
    console.error(
      `[${records.length}/${jobs.length}] ${task.id} s${sampleIndex}: ${record.pass ? "PASS" : "FAIL"}` +
        `${record.violations.length > 0 ? ` (${record.violations.length} violation(s))` : ""}` +
        ` ${Math.round(record.durationMs / 1000)}s`,
    );
    const entry = perTask.get(task.id) ?? {
      taskId: task.id,
      domain: task.domain,
      samples: [],
      costUSD: 0,
    };
    entry.samples.push(record.pass);
    entry.costUSD += record.costUSD;
    perTask.set(task.id, entry);
  });

  return {
    ...aggregate([...perTask.values()]),
    metadata: {
      agentId: options.agentId,
      ...readAgentModel(options.agentId),
      gitRevision: git.revision,
      gitDirty: git.dirty,
      startedAt,
      finishedAt: new Date().toISOString(),
      samplesPerTask: options.samples,
      concurrency: options.concurrency,
      seed,
      taskIds: options.tasks.map((task) => task.id).sort(),
    },
    sampleReport: buildSampleReport(records),
  };
}

export async function runAB(
  tasks: EvalTask[],
  agentA: string,
  agentB: string,
  samples: number,
  concurrency: number,
  judgeOk: boolean,
  seed?: number,
): Promise<{
  a: SuiteRunReport;
  b: SuiteRunReport;
  delta: { passAt1: number; passHatK: number };
  paired: PairedComparison;
}> {
  const first = await runSuite({
    tasks,
    agentId: agentA,
    samples,
    concurrency,
    judgeOk,
    ...(seed !== undefined ? { seed } : {}),
  });
  const second = await runSuite({
    tasks,
    agentId: agentB,
    samples,
    concurrency,
    judgeOk,
    ...(seed !== undefined ? { seed } : {}),
  });
  return {
    a: first,
    b: second,
    delta: {
      passAt1: abDelta(first.overall.passAt1, second.overall.passAt1).delta,
      passHatK: abDelta(first.overall.passHatK, second.overall.passHatK).delta,
    },
    paired: pairSamples(first.sampleReport.samples, second.sampleReport.samples),
  };
}

/**
 * Pair a finished run with a baseline report written earlier and judge it against the
 * adversarial targets. The baseline must come from the same agent and model; a mismatch is
 * refused rather than compared.
 */
export function compareReports(
  baseline: SuiteRunReport,
  final: SuiteRunReport,
): { paired: PairedComparison; targets: TargetVerdict[] } {
  const same =
    baseline.metadata.agentId === final.metadata.agentId &&
    baseline.metadata.provider === final.metadata.provider &&
    baseline.metadata.model === final.metadata.model &&
    baseline.metadata.reasoning === final.metadata.reasoning;
  if (!same) {
    throw new Error(
      `eval compare: baseline ran ${baseline.metadata.provider}/${baseline.metadata.model} as ${baseline.metadata.agentId}, final ran ${final.metadata.provider}/${final.metadata.model} as ${final.metadata.agentId}; paired runs must use the same pinned agent and model.`,
    );
  }
  const adversarial = (report: SuiteRunReport) =>
    report.sampleReport.samples.filter((sample) => sample.domain === "adversarial");
  const paired = pairSamples(adversarial(baseline), adversarial(final));
  return {
    paired,
    targets: evaluateAdversarialTargets(buildSampleReport(adversarial(final)), paired),
  };
}

async function loadTasks(): Promise<EvalTask[]> {
  if (!existsSync(TASKS_DIR)) {
    return [];
  }
  const tasks: EvalTask[] = [];
  for (const domain of readdirSync(TASKS_DIR)) {
    const domainDir = join(TASKS_DIR, domain);
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }
      const module = (await import(join(domainDir, file))) as { tasks?: EvalTask[] };
      if (Array.isArray(module.tasks)) {
        tasks.push(...module.tasks);
      }
    }
  }
  return tasks;
}

function loadCalibration(): CalibrationRow[] {
  return readJsonLines<CalibrationRow>(CALIBRATION_PATH);
}

/**
 * Cost guardrail: refuse to run any agent whose model isn't free-or-cheap.
 * Checks the same agent file a sample runs as (`resolveAgentConfigPath`: the checked-in
 * eval agent, else the one in `jazzHome`) against isAllowedEvalModel.
 */
export function assertAllowedAgent(
  agentId: string,
  jazzHome: string = getJazzHomeDirectory(),
): void {
  const agentPath = resolveAgentConfigPath(agentId, jazzHome);
  let parsed: { config?: { llmProvider?: string; llmModel?: string } };
  try {
    parsed = JSON.parse(readFileSync(agentPath, "utf-8")) as {
      config?: { llmProvider?: string; llmModel?: string };
    };
  } catch {
    throw new Error(`eval: cannot read agent "${agentId}" at ${agentPath} to verify its model.`);
  }
  const provider = parsed.config?.llmProvider ?? "";
  const model = parsed.config?.llmModel ?? "";
  if (!isAllowedEvalModel(provider, model)) {
    throw new Error(
      `eval cost guardrail: agent "${agentId}" uses "${provider}/${model}". Only OpenRouter ":free" models, Ollama models, or gpt-5.4-nano/gpt-5.4-mini are permitted.`,
    );
  }
}

function parseFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function readReport(path: string): SuiteRunReport {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SuiteRunReport>;
  if (parsed.metadata === undefined || parsed.sampleReport === undefined) {
    throw new Error(`eval compare: ${path} is not a single-agent suite report with samples.`);
  }
  return parsed as SuiteRunReport;
}

export async function runCli(): Promise<void> {
  try {
    const compareIndex = process.argv.indexOf("--compare");
    if (compareIndex >= 0) {
      const baselinePath = process.argv[compareIndex + 1];
      const finalPath = process.argv[compareIndex + 2];
      if (baselinePath === undefined || finalPath === undefined) {
        throw new Error("usage: bun run evals --compare <baseline.json> <final.json>");
      }
      console.log(
        JSON.stringify(compareReports(readReport(baselinePath), readReport(finalPath)), null, 2),
      );
      return;
    }

    const agentId = parseFlag("--agent") ?? EVAL_CONFIG.sutAgentId;
    const abAgent = parseFlag("--ab");
    const samples = Number(parseFlag("--samples") ?? EVAL_CONFIG.samplesPerTask);
    const seedFlag = parseFlag("--seed");
    const seed = seedFlag === undefined ? undefined : Number(seedFlag);
    const baselinePath = parseFlag("--baseline");
    const concurrency = Number(parseFlag("--concurrency") ?? EVAL_CONFIG.concurrency);
    const samplesBeyondEasyFlag = parseFlag("--samples-beyond-easy");
    assertAllowedAgent(agentId);
    if (abAgent) {
      assertAllowedAgent(abAgent);
    }
    const taskId = parseFlag("--task");
    const domain = parseFlag("--domain");
    const domains = domain === undefined ? undefined : new Set(domain.split(","));
    const tasks = (await loadTasks()).filter(
      (task) =>
        (taskId === undefined || task.id === taskId) &&
        (domains === undefined || domains.has(task.domain)),
    );
    if (tasks.length === 0) {
      console.error(
        taskId || domain
          ? `No eval task found for ${taskId ? `id ${taskId}` : `domain ${domain}`}`
          : `No tasks found under ${TASKS_DIR}`,
      );
      process.exitCode = 1;
      return;
    }

    // The judge only scores rubrics, so a selection without one never needs it, its
    // provider, or a calibration pass.
    let judgeOk = true;
    if (tasks.some((task) => task.rubric !== undefined)) {
      assertAllowedAgent(EVAL_CONFIG.judgeAgentId);
      const calibration = loadCalibration();
      if (calibration.length > 0) {
        const { r, ok } = await calibrateJudge(makeJudge(), calibration);
        judgeOk = ok;
        console.error(
          `Judge calibration: Pearson r=${r.toFixed(3)} (${ok ? "OK" : "UNRELIABLE — rubric scores flagged"})`,
        );
      }
    }

    const stamp = parseFlag("--stamp") ?? "run";
    let report: unknown;
    if (abAgent) {
      report = await runAB(tasks, agentId, abAgent, samples, concurrency, judgeOk, seed);
    } else {
      const suite = await runSuite({
        tasks,
        agentId,
        samples,
        concurrency,
        judgeOk,
        ...(seed !== undefined ? { seed } : {}),
        ...(samplesBeyondEasyFlag !== undefined
          ? { samplesBeyondEasy: Number(samplesBeyondEasyFlag) }
          : {}),
      });
      report =
        baselinePath === undefined
          ? suite
          : { ...suite, comparison: compareReports(readReport(baselinePath), suite) };
    }
    const outPath = reportFilePath(`${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`Report written to ${outPath}`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("eval run failed:", error);
    process.exitCode = 1;
  }
}

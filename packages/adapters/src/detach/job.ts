/**
 * Durable queue for a conversation handed to this host over SSH.
 *
 * Enqueue is idempotent by handoff ID. The daemon claims one pending record
 * before running it, and never automatically replays a running record after a
 * crash: the last tool may have acted before the process died. Status files
 * live in a private Jazz directory and are replaced atomically.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { buildWorkStatePreamble } from "@jazz/core/agent/context/work-state-preamble";
import { isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { resumeRun } from "@jazz/core/agent/run/resume";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { loadConversation, saveConversation } from "../history/conversation-history-service";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface EnqueueDetachedJobInput {
  readonly handoffId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly continuation: string;
  readonly approvalPolicy: "low-risk";
  readonly maxCostUSD: number;
  readonly maxDurationMs: number;
  readonly maxIterations: number;
}

export type DetachedJobStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly pid: number; readonly host: string }
  | { readonly kind: "parked"; readonly runId: string }
  | { readonly kind: "answer-pending"; readonly runId: string; readonly approved: boolean }
  | {
      readonly kind: "answer-running";
      readonly runId: string;
      readonly approved: boolean;
      readonly pid: number;
      readonly host: string;
    }
  | { readonly kind: "completed"; readonly answer: string }
  | { readonly kind: "failed"; readonly error: string };

export interface DetachedJobRecord {
  readonly version: 1;
  readonly input: EnqueueDetachedJobInput;
  readonly status: DetachedJobStatus;
  /** Operator decision retained across terminal status for idempotent retries. */
  readonly answered?: boolean;
  /** Consumption from completed execution segments, excluding time spent parked. */
  readonly spentCostUSD: number;
  readonly spentDurationMs: number;
  readonly spentIterations: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function directory(): string {
  return path.join(getJazzHomeDirectory(), "detach", "jobs");
}

function jobPath(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid detach handoff ID");
  return path.join(directory(), `${id}.json`);
}

/** Short cross-process lock around compare-and-replace state changes. */
async function withJobLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${jobPath(id)}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      try {
        return await operation();
      } finally {
        await fs.rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for detach job lock");
}

function validate(input: EnqueueDetachedJobInput): void {
  if (![input.handoffId, input.agentId, input.conversationId].every((id) => ID.test(id))) {
    throw new Error("Invalid detach job identity");
  }
  if (
    !path.isAbsolute(input.workspacePath) ||
    path.resolve(input.workspaceRoot) !==
      path.join(path.resolve(input.workspacePath), input.handoffId)
  ) {
    throw new Error("Detach workspace must be the handoff directory on this host");
  }
  if (
    input.continuation.trim().length === 0 ||
    input.continuation.length > 20_000 ||
    input.approvalPolicy !== "low-risk" ||
    !Number.isFinite(input.maxCostUSD) ||
    input.maxCostUSD <= 0 ||
    !Number.isSafeInteger(input.maxDurationMs) ||
    input.maxDurationMs <= 0 ||
    !Number.isSafeInteger(input.maxIterations) ||
    input.maxIterations <= 0
  ) {
    throw new Error("Invalid detach continuation or run limits");
  }
}

async function read(id: string): Promise<DetachedJobRecord | undefined> {
  const file = jobPath(id);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<DetachedJobRecord>).version !== 1 ||
    (parsed as Partial<DetachedJobRecord>).input?.handoffId !== id ||
    !Number.isFinite((parsed as Partial<DetachedJobRecord>).spentCostUSD) ||
    (parsed as Partial<DetachedJobRecord>).spentCostUSD! < 0 ||
    !Number.isSafeInteger((parsed as Partial<DetachedJobRecord>).spentDurationMs) ||
    (parsed as Partial<DetachedJobRecord>).spentDurationMs! < 0 ||
    !Number.isSafeInteger((parsed as Partial<DetachedJobRecord>).spentIterations) ||
    (parsed as Partial<DetachedJobRecord>).spentIterations! < 0
  )
    throw new Error("Corrupt detach job record");
  return parsed as DetachedJobRecord;
}

async function write(record: DetachedJobRecord): Promise<void> {
  const target = jobPath(record.input.handoffId);
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  const temporary = path.join(directory(), `.${record.input.handoffId}-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Save a job once, returning the same record on an identical retry. */
export function enqueueDetachedJob(input: EnqueueDetachedJobInput) {
  return Effect.tryPromise({
    try: async () => {
      validate(input);
      await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
      const now = new Date().toISOString();
      const record: DetachedJobRecord = {
        version: 1,
        input,
        status: { kind: "pending" },
        spentCostUSD: 0,
        spentDurationMs: 0,
        spentIterations: 0,
        createdAt: now,
        updatedAt: now,
      };
      const temporary = path.join(directory(), `.${input.handoffId}-${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temporary, jobPath(input.handoffId));
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await read(input.handoffId);
        if (existing !== undefined && JSON.stringify(existing.input) === JSON.stringify(input))
          return existing;
        throw new Error("Handoff ID already belongs to a different job", { cause: error });
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/** Read one durable job, or undefined if its ID has never been enqueued. */
export function readDetachedJob(id: string) {
  return Effect.tryPromise({
    try: () => read(id),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/** Record the terminal result of a parked run answered by an operator. */
export function settleDetachedJob(
  handoffId: string,
  status: "completed" | "failed",
  detail: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const current = await read(handoffId);
      if (current?.status.kind !== "parked") {
        throw new Error("Detached job is not waiting for an operator");
      }
      await setStatus(
        current,
        status === "completed"
          ? { kind: "completed", answer: detail }
          : { kind: "failed", error: detail },
      );
      return (await read(handoffId)) as DetachedJobRecord;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/** Queue a yes/no answer without running the rest of the agent over SSH. */
export function queueDetachedAnswer(handoffId: string, approved: boolean) {
  return Effect.tryPromise({
    try: () =>
      withJobLock(handoffId, async () => {
        const current = await read(handoffId);
        if (current === undefined) throw new Error("Detached job does not exist");
        if (current.status.kind === "answer-pending" || current.status.kind === "answer-running") {
          if (current.status.approved !== approved)
            throw new Error("Conflicting answer to detached run");
          return current;
        }
        if (current.answered !== undefined) {
          if (current.answered !== approved) throw new Error("Conflicting answer to detached run");
          return current;
        }
        if (current.status.kind !== "parked")
          throw new Error("Detached job is not awaiting approval");
        await write({
          ...current,
          answered: approved,
          status: { kind: "answer-pending", runId: current.status.runId, approved },
          updatedAt: new Date().toISOString(),
        });
        return (await read(handoffId)) as DetachedJobRecord;
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

async function claim(id: string): Promise<DetachedJobRecord | undefined> {
  return withJobLock(id, async () => {
    const current = await read(id);
    if (current?.status.kind !== "pending" && current?.status.kind !== "answer-pending") {
      return undefined;
    }
    const status: DetachedJobStatus =
      current.status.kind === "pending"
        ? { kind: "running", pid: process.pid, host: os.hostname() }
        : { ...current.status, kind: "answer-running", pid: process.pid, host: os.hostname() };
    const next: DetachedJobRecord = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };
    await write(next);
    return next;
  });
}

function runOne(record: DetachedJobRecord) {
  return Effect.gen(function* () {
    const input = record.input;
    const fsContext = yield* FileSystemContextServiceTag;
    yield* fsContext.setCwd(
      { agentId: input.agentId, conversationId: input.conversationId },
      input.workspaceRoot,
    );
    const agent = yield* getAgentByIdentifier(input.agentId);
    const prior = yield* loadConversation(input.agentId, input.conversationId);
    if (prior === null) return yield* Effect.fail(new Error("Imported conversation is missing"));
    const preamble = yield* buildWorkStatePreamble(input.agentId, input.conversationId, {
      modelHint: { provider: agent.config.llmProvider, modelId: agent.config.llmModel },
    });
    const response = yield* AgentRunner.run({
      agent,
      conversationId: input.conversationId,
      conversationHistory: preamble === undefined ? prior.messages : [preamble, ...prior.messages],
      userInput: input.continuation,
      autoApprovePolicy: input.approvalPolicy,
      maxCostUSD: input.maxCostUSD,
      maxDurationMs: input.maxDurationMs,
      maxIterations: input.maxIterations,
      withholdInteractiveTools: true,
      parkWhenUnattended: true,
    }).pipe(
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error) || error.messages === undefined) return Effect.fail(error);
        return saveConversation({
          ...prior,
          endedAt: new Date().toISOString(),
          messages: [...error.messages],
        }).pipe(Effect.flatMap(() => Effect.fail(error)));
      }),
    );
    yield* saveConversation({
      ...prior,
      endedAt: new Date().toISOString(),
      messages: response.messages ?? prior.messages,
    });
    return { content: response.content, costUSD: response.costUSD ?? 0 };
  });
}

/** Remaining caps before a resumed segment starts; a spent cap refuses the approval. */
export function remainingDetachedBudgets(record: DetachedJobRecord): {
  readonly maxCostUSD: number;
  readonly maxDurationMs: number;
  readonly maxIterations: number;
} {
  if (
    !Number.isFinite(record.spentCostUSD) ||
    record.spentCostUSD < 0 ||
    !Number.isSafeInteger(record.spentDurationMs) ||
    record.spentDurationMs < 0 ||
    !Number.isSafeInteger(record.spentIterations) ||
    record.spentIterations < 0
  ) {
    throw new Error("Detached job has invalid budget accounting");
  }
  const maxCostUSD = record.input.maxCostUSD - record.spentCostUSD;
  const maxDurationMs = record.input.maxDurationMs - record.spentDurationMs;
  const maxIterations = record.input.maxIterations - record.spentIterations;
  if (maxCostUSD <= 0 || maxDurationMs <= 0 || maxIterations <= 0) {
    throw new Error("Detached job budget is exhausted; approval cannot resume it");
  }
  return { maxCostUSD, maxDurationMs, maxIterations };
}

/** Finish a parked run under the same remote cwd, policy and budgets. */
function resumeOne(record: DetachedJobRecord) {
  return Effect.gen(function* () {
    if (record.status.kind !== "answer-running") {
      return yield* Effect.fail(new Error("Detached job has no queued answer"));
    }
    const input = record.input;
    const fsContext = yield* FileSystemContextServiceTag;
    yield* fsContext.setCwd(
      { agentId: input.agentId, conversationId: input.conversationId },
      input.workspaceRoot,
    );
    const prior = yield* loadConversation(input.agentId, input.conversationId);
    if (prior === null) return yield* Effect.fail(new Error("Imported conversation is missing"));
    const remaining = yield* Effect.try(() => remainingDetachedBudgets(record));
    const response = yield* resumeRun({
      runId: record.status.runId,
      outcome: { kind: "approval", value: { approved: record.status.approved } },
      autoApprovePolicy: input.approvalPolicy,
      ...remaining,
      withholdInteractiveTools: true,
    }).pipe(
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error) || error.messages === undefined) return Effect.fail(error);
        return saveConversation({
          ...prior,
          endedAt: new Date().toISOString(),
          messages: [...error.messages],
        }).pipe(Effect.flatMap(() => Effect.fail(error)));
      }),
    );
    yield* saveConversation({
      ...prior,
      endedAt: new Date().toISOString(),
      messages: response.messages ?? prior.messages,
    });
    return { content: response.content, costUSD: response.costUSD ?? 0 };
  });
}

async function setStatus(
  record: DetachedJobRecord,
  status: DetachedJobStatus,
  spent?: { readonly costUSD: number; readonly durationMs: number; readonly iterations: number },
): Promise<void> {
  const next = {
    ...record,
    status,
    spentCostUSD: record.spentCostUSD + (spent?.costUSD ?? 0),
    spentDurationMs: record.spentDurationMs + (spent?.durationMs ?? 0),
    spentIterations: record.spentIterations + (spent?.iterations ?? 0),
    updatedAt: new Date().toISOString(),
  };
  if (status.kind === "parked") {
    const { answered: _previousAnswer, ...rest } = next;
    await write(rest);
    return;
  }
  await write(next);
}

/** Claim and run every pending job on a daemon tick. Never replay a running job. */
export function runDueDetachedJobs() {
  return Effect.gen(function* () {
    const runStore = yield* RunStoreTag;
    yield* recoverInterruptedDetachedJobs();
    const files = yield* Effect.tryPromise(() => fs.readdir(directory())).pipe(
      Effect.catchAll(() => Effect.succeed<string[]>([])),
    );
    for (const file of files) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(file)) continue;
      const id = file.slice(0, -5);
      const existing = yield* Effect.tryPromise(() => read(id)).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (existing?.status.kind === "running" || existing?.status.kind === "answer-running")
        continue;
      if (existing?.status.kind === "parked") {
        const run = yield* runStore.get(existing.status.runId);
        if (run === undefined) {
          yield* Effect.tryPromise(() =>
            setStatus(existing, {
              kind: "failed",
              error: "Parked run record is missing; review remote state before retrying",
            }),
          );
        } else if (run.state.kind === "completed") {
          const answer = run.state.content;
          yield* Effect.tryPromise(() =>
            setStatus(existing, {
              kind: "completed",
              answer,
            }),
          );
        } else if (run?.state.kind === "failed" || run?.state.kind === "canceled") {
          const error = run.state.kind === "failed" ? run.state.error : "Run cancelled";
          yield* Effect.tryPromise(() =>
            setStatus(existing, {
              kind: "failed",
              error,
            }),
          );
        }
        continue;
      }
      const record = yield* Effect.tryPromise(() => claim(id)).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (record === undefined) continue;
      yield* Effect.forkDaemon(executeClaimed(record));
    }
  });
}

/** Turn an abandoned worker into an explicit failure without replaying side effects. */
export function recoverInterruptedDetachedJobs() {
  return Effect.tryPromise({
    try: async () => {
      const files = await fs.readdir(directory()).catch(() => [] as string[]);
      let recovered = 0;
      for (const file of files) {
        if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(file)) continue;
        const current = await read(file.slice(0, -5)).catch(() => undefined);
        if (
          current !== undefined &&
          (current.status.kind === "running" || current.status.kind === "answer-running") &&
          current.status.host === os.hostname() &&
          !processAlive(current.status.pid)
        ) {
          await setStatus(current, {
            kind: "failed",
            error: "Worker interrupted; review side effects before retrying",
          });
          recovered++;
        }
      }
      return recovered;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Detached fiber: the periodic daemon sweep must not wait for a whole LLM run. */
function executeClaimed(record: DetachedJobRecord) {
  return Effect.gen(function* () {
    const outcome = yield* (
      record.status.kind === "answer-running" ? resumeOne(record) : runOne(record)
    ).pipe(Effect.either);
    if (outcome._tag === "Right") {
      yield* Effect.tryPromise(() =>
        setStatus(
          record,
          { kind: "completed", answer: outcome.right.content },
          {
            costUSD: outcome.right.costUSD,
            durationMs: Math.max(0, Date.now() - new Date(record.updatedAt).getTime()),
            iterations: 0,
          },
        ),
      );
    } else if (isRunParkRequested(outcome.left) && outcome.left.runId !== undefined) {
      const runId = outcome.left.runId;
      if (outcome.left.costUSD === undefined || outcome.left.iteration === undefined) {
        yield* Effect.tryPromise(() =>
          setStatus(record, {
            kind: "failed",
            error: "Cannot account for detached run budget after approval park",
          }),
        );
        return;
      }
      const costUSD = outcome.left.costUSD;
      const iterations = outcome.left.iteration;
      yield* Effect.tryPromise(() =>
        setStatus(
          record,
          { kind: "parked", runId },
          {
            costUSD,
            durationMs: Math.max(0, Date.now() - new Date(record.updatedAt).getTime()),
            iterations,
          },
        ),
      );
    } else {
      const error = outcome.left instanceof Error ? outcome.left.message : String(outcome.left);
      yield* Effect.tryPromise(() => setStatus(record, { kind: "failed", error }));
    }
  });
}

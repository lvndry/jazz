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
import {
  buildWorkStatePreamble,
  isWorkStatePreamble,
} from "@jazz/core/agent/context/work-state-preamble";
import { isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { resumeRun } from "@jazz/core/agent/run/resume";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { Agent } from "@jazz/core/types/agent";
import type { ChatMessage } from "@jazz/core/types/message";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { appendDetachEvent, DetachEventRecorder, recordingPresentationService } from "./events";
import { loadConversation, saveConversation } from "../history/conversation-history-service";
import { detectKeyringBackend, keyringGet } from "../secrets/keyring";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE_CHARS = 20_000;
const CANCEL_POLL_MS = 1_000;

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
  | { readonly kind: "message-pending"; readonly text: string }
  | {
      readonly kind: "message-running";
      readonly text: string;
      readonly pid: number;
      readonly host: string;
    }
  | { readonly kind: "completed"; readonly answer: string }
  | { readonly kind: "failed"; readonly error: string }
  /** Handed back to the source machine by `jazz detach reclaim`; this host never runs it again. */
  | { readonly kind: "released" };

const ACTIVE_KINDS: ReadonlySet<DetachedJobStatus["kind"]> = new Set([
  "pending",
  "running",
  "answer-pending",
  "answer-running",
  "message-pending",
  "message-running",
]);

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
  if (!ID.test(id)) {
    throw new Error("Invalid detach handoff ID");
  }
  return path.join(directory(), `${id}.json`);
}

function cancelMarkerPath(id: string): string {
  return `${jobPath(id)}.cancel`;
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
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
  ) {
    throw new Error("Corrupt detach job record");
  }
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
        await appendDetachEvent(input.handoffId, { type: "user", text: input.continuation });
        await appendDetachEvent(input.handoffId, { type: "status", state: "pending" });
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existing = await read(input.handoffId);
        if (existing !== undefined && JSON.stringify(existing.input) === JSON.stringify(input)) {
          return existing;
        }
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
        if (current === undefined) {
          throw new Error("Detached job does not exist");
        }
        if (current.status.kind === "answer-pending" || current.status.kind === "answer-running") {
          if (current.status.approved !== approved) {
            throw new Error("Conflicting answer to detached run");
          }
          return current;
        }
        if (current.answered !== undefined) {
          if (current.answered !== approved) {
            throw new Error("Conflicting answer to detached run");
          }
          return current;
        }
        if (current.status.kind !== "parked") {
          throw new Error("Detached job is not awaiting approval");
        }
        await write({
          ...current,
          answered: approved,
          status: { kind: "answer-pending", runId: current.status.runId, approved },
          updatedAt: new Date().toISOString(),
        });
        await appendDetachEvent(handoffId, {
          type: "status",
          state: "answer-pending",
          detail: approved ? "approved" : "rejected",
        });
        return (await read(handoffId)) as DetachedJobRecord;
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/**
 * Queue another turn on a finished conversation, as if the operator typed it in the chat.
 * It spends from the same budget as the rest of the handoff.
 */
export function queueDetachedMessage(handoffId: string, text: string) {
  return Effect.tryPromise({
    try: () =>
      withJobLock(handoffId, async () => {
        const trimmed = text.trim();
        if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_CHARS) {
          throw new Error("Reply must be between 1 and 20000 characters");
        }
        const current = await read(handoffId);
        if (current === undefined) {
          throw new Error("Detached job does not exist");
        }
        if (current.status.kind !== "completed") {
          throw new Error(`Detached run is ${current.status.kind}; replies need a finished turn`);
        }
        remainingDetachedBudgets(current);
        await write({
          ...current,
          status: { kind: "message-pending", text: trimmed },
          updatedAt: new Date().toISOString(),
        });
        await appendDetachEvent(handoffId, { type: "user", text: trimmed });
        await appendDetachEvent(handoffId, { type: "status", state: "message-pending" });
        return (await read(handoffId)) as DetachedJobRecord;
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/**
 * Stop a detached run. Queued and parked work fails immediately; a turn that is already
 * executing is interrupted by its worker, which polls for the marker this leaves behind.
 */
export function requestDetachedCancel(handoffId: string) {
  return Effect.tryPromise({
    try: () =>
      withJobLock(handoffId, async () => {
        const current = await read(handoffId);
        if (current === undefined) {
          throw new Error("Detached job does not exist");
        }
        const kind = current.status.kind;
        if (kind === "running" || kind === "answer-running" || kind === "message-running") {
          await fs.writeFile(cancelMarkerPath(handoffId), "", { mode: 0o600 });
          return current;
        }
        if (kind === "pending" || kind === "answer-pending" || kind === "message-pending") {
          await setStatus(current, { kind: "failed", error: "Cancelled by operator" });
          return (await read(handoffId)) as DetachedJobRecord;
        }
        if (kind === "parked") {
          await setStatus(current, { kind: "failed", error: "Cancelled by operator" });
          return (await read(handoffId)) as DetachedJobRecord;
        }
        throw new Error(`Detached run is already ${kind}`);
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/**
 * Freeze a settled job so the source machine can take the conversation back. Idempotent:
 * a reclaim that lost its connection after this point releases again and re-downloads.
 */
export function releaseDetachedJob(handoffId: string) {
  return Effect.tryPromise({
    try: () =>
      withJobLock(handoffId, async () => {
        const current = await read(handoffId);
        if (current === undefined) {
          throw new Error("Detached job does not exist");
        }
        if (current.status.kind === "released") {
          return current;
        }
        if (ACTIVE_KINDS.has(current.status.kind)) {
          throw new Error(
            "Detached run is still working; wait for it or cancel it before reclaiming",
          );
        }
        await setStatus(current, { kind: "released" });
        return (await read(handoffId)) as DetachedJobRecord;
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

async function claim(id: string): Promise<DetachedJobRecord | undefined> {
  return withJobLock(id, async () => {
    const current = await read(id);
    if (current === undefined) {
      return undefined;
    }
    const owner = { pid: process.pid, host: os.hostname() };
    let status: DetachedJobStatus;
    if (current.status.kind === "pending") {
      status = { kind: "running", ...owner };
    } else if (current.status.kind === "answer-pending") {
      status = { ...current.status, kind: "answer-running", ...owner };
    } else if (current.status.kind === "message-pending") {
      status = { kind: "message-running", text: current.status.text, ...owner };
    } else {
      return undefined;
    }
    const next: DetachedJobRecord = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };
    await write(next);
    await appendDetachEvent(id, { type: "status", state: status.kind });
    return next;
  });
}

/** The transcript as persisted: the work-state preamble is rebuilt per turn, never stored. */
function withoutPreamble(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isWorkStatePreamble(message));
}

/** Model iterations a finished turn spent: one assistant message per LLM round trip. */
function newAssistantTurns(priorLength: number, messages: readonly ChatMessage[] | undefined) {
  return withoutPreamble(messages ?? [])
    .slice(priorLength)
    .filter((message) => message.role === "assistant").length;
}

/**
 * The provider key as this host stores it right now. The daemon resolves config secrets once
 * at startup, but a handoff imports its key over SSH afterwards, so each turn reads it fresh.
 */
function hostProviderKeys(agent: Agent) {
  return Effect.gen(function* () {
    const provider = agent.config.llmProvider;
    const backend = yield* detectKeyringBackend();
    const key = yield* keyringGet(backend, `llm.${provider}.api_key`);
    return key === undefined || key.length === 0 ? {} : { [provider]: key };
  });
}

function withHostProviderKeys(agent: Agent) {
  return hostProviderKeys(agent).pipe(
    Effect.map((keys) => ({
      ...agent,
      config: { ...agent.config, llmApiKeys: { ...agent.config.llmApiKeys, ...keys } },
    })),
  );
}

interface TurnLimits {
  readonly maxCostUSD: number;
  readonly maxDurationMs: number;
  readonly maxIterations: number;
}

/** One agent turn on the imported conversation: the initial continuation or a later reply. */
function runTurn(record: DetachedJobRecord, userInput: string, limits: TurnLimits) {
  return Effect.gen(function* () {
    const input = record.input;
    const fsContext = yield* FileSystemContextServiceTag;
    yield* fsContext.setCwd(
      { agentId: input.agentId, conversationId: input.conversationId },
      input.workspaceRoot,
    );
    const agent = yield* getAgentByIdentifier(input.agentId).pipe(
      Effect.flatMap(withHostProviderKeys),
    );
    const prior = yield* loadConversation(input.agentId, input.conversationId);
    if (prior === null) {
      return yield* Effect.fail(new Error("Imported conversation is missing"));
    }
    const preamble = yield* buildWorkStatePreamble(input.agentId, input.conversationId, {
      modelHint: { provider: agent.config.llmProvider, modelId: agent.config.llmModel },
    });
    const response = yield* AgentRunner.run({
      agent,
      conversationId: input.conversationId,
      conversationHistory: preamble === undefined ? prior.messages : [preamble, ...prior.messages],
      userInput,
      autoApprovePolicy: input.approvalPolicy,
      ...limits,
      stream: true,
      withholdInteractiveTools: true,
      parkWhenUnattended: true,
    }).pipe(
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error) || error.messages === undefined) {
          return Effect.fail(error);
        }
        return saveConversation({
          ...prior,
          endedAt: new Date().toISOString(),
          messages: withoutPreamble(error.messages),
        }).pipe(Effect.flatMap(() => Effect.fail(error)));
      }),
    );
    yield* saveConversation({
      ...prior,
      endedAt: new Date().toISOString(),
      messages: withoutPreamble(response.messages ?? prior.messages),
    });
    return {
      content: response.content,
      costUSD: response.costUSD ?? 0,
      iterations: newAssistantTurns(prior.messages.length, response.messages),
    };
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
    if (prior === null) {
      return yield* Effect.fail(new Error("Imported conversation is missing"));
    }
    const remaining = yield* Effect.try(() => remainingDetachedBudgets(record));
    const providerApiKeys = yield* getAgentByIdentifier(input.agentId).pipe(
      Effect.flatMap(hostProviderKeys),
    );
    const response = yield* resumeRun({
      runId: record.status.runId,
      outcome: { kind: "approval", value: { approved: record.status.approved } },
      autoApprovePolicy: input.approvalPolicy,
      ...remaining,
      withholdInteractiveTools: true,
      providerApiKeys,
    }).pipe(
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error) || error.messages === undefined) {
          return Effect.fail(error);
        }
        return saveConversation({
          ...prior,
          endedAt: new Date().toISOString(),
          messages: withoutPreamble(error.messages),
        }).pipe(Effect.flatMap(() => Effect.fail(error)));
      }),
    );
    yield* saveConversation({
      ...prior,
      endedAt: new Date().toISOString(),
      messages: withoutPreamble(response.messages ?? prior.messages),
    });
    return {
      content: response.content,
      costUSD: response.costUSD ?? 0,
      iterations: newAssistantTurns(prior.messages.length, response.messages),
    };
  });
}

async function setStatus(
  record: DetachedJobRecord,
  status: DetachedJobStatus,
  spent?: { readonly costUSD: number; readonly durationMs: number; readonly iterations: number },
  /** Shown to an attached operator: what a parked run is waiting on. */
  detail?: string,
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
  } else {
    await write(next);
  }
  await appendDetachEvent(record.input.handoffId, {
    type: "status",
    state: status.kind,
    ...(status.kind === "failed" ? { detail: status.error } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
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
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(file)) {
        continue;
      }
      const id = file.slice(0, -5);
      const existing = yield* Effect.tryPromise(() => read(id)).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (
        existing?.status.kind === "running" ||
        existing?.status.kind === "answer-running" ||
        existing?.status.kind === "message-running"
      ) {
        continue;
      }
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
      if (record === undefined) {
        continue;
      }
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
        if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(file)) {
          continue;
        }
        const current = await read(file.slice(0, -5)).catch(() => undefined);
        if (
          current !== undefined &&
          (current.status.kind === "running" ||
            current.status.kind === "answer-running" ||
            current.status.kind === "message-running") &&
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

/** Resolve when the operator has asked to cancel this job; the race loser is interrupted. */
function watchForCancel(handoffId: string) {
  return Effect.gen(function* () {
    for (;;) {
      const requested = yield* Effect.promise(() =>
        fs.stat(cancelMarkerPath(handoffId)).then(
          () => true,
          () => false,
        ),
      );
      if (requested) {
        return yield* Effect.fail(new Error("Cancelled by operator"));
      }
      yield* Effect.sleep(CANCEL_POLL_MS);
    }
  });
}

function turnFor(record: DetachedJobRecord) {
  if (record.status.kind === "answer-running") {
    return resumeOne(record);
  }
  if (record.status.kind === "message-running") {
    const text = record.status.text;
    return Effect.try(() => remainingDetachedBudgets(record)).pipe(
      Effect.flatMap((remaining) => runTurn(record, text, remaining)),
    );
  }
  const input = record.input;
  return runTurn(record, input.continuation, {
    maxCostUSD: input.maxCostUSD,
    maxDurationMs: input.maxDurationMs,
    maxIterations: input.maxIterations,
  });
}

/** Detached fiber: the periodic daemon sweep must not wait for a whole LLM run. */
function executeClaimed(record: DetachedJobRecord) {
  return Effect.gen(function* () {
    const handoffId = record.input.handoffId;
    const recorder = new DetachEventRecorder(handoffId);
    const presentation = yield* PresentationServiceTag;
    const outcome = yield* turnFor(record).pipe(
      Effect.provideService(
        PresentationServiceTag,
        recordingPresentationService(presentation, recorder),
      ),
      Effect.raceFirst(watchForCancel(handoffId)),
      Effect.either,
    );
    yield* Effect.promise(() => fs.rm(cancelMarkerPath(handoffId), { force: true }));
    if (outcome._tag === "Right" && !recorder.sawText && outcome.right.content.length > 0) {
      recorder.record({ type: "text", delta: outcome.right.content });
      recorder.record({ type: "response_end" });
    }
    yield* Effect.promise(() => recorder.close());
    if (outcome._tag === "Right") {
      yield* Effect.tryPromise(() =>
        setStatus(
          record,
          { kind: "completed", answer: outcome.right.content },
          {
            costUSD: outcome.right.costUSD,
            durationMs: Math.max(0, Date.now() - new Date(record.updatedAt).getTime()),
            iterations: outcome.right.iterations,
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
      const run = yield* (yield* RunStoreTag).get(runId);
      const pending =
        run?.state.kind === "input-required" && run.state.pending.kind === "tool-approval"
          ? `${run.state.pending.request.toolName}: ${run.state.pending.request.message}`
          : undefined;
      yield* Effect.tryPromise(() =>
        setStatus(
          record,
          { kind: "parked", runId },
          {
            costUSD,
            durationMs: Math.max(0, Date.now() - new Date(record.updatedAt).getTime()),
            iterations,
          },
          pending,
        ),
      );
    } else {
      const error = outcome.left instanceof Error ? outcome.left.message : String(outcome.left);
      yield* Effect.tryPromise(() => setStatus(record, { kind: "failed", error }));
    }
  });
}

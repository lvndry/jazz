/**
 * Private SSH-side detach protocol entry points.
 *
 * These commands receive framed bytes or bounded JSON on stdin. They take no task data in
 * shell arguments and emit only small acknowledgments. The remote daemon consumes accepted
 * jobs from its durable queue, so the SSH process can return before the agent finishes.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { readDetachEventLines } from "@jazz/adapters/detach/events";
import {
  enqueueDetachedJob,
  queueDetachedAnswer,
  queueDetachedMessage,
  readDetachedJob,
  releaseDetachedJob,
  requestDetachedCancel,
  type DetachedJobRecord,
} from "@jazz/adapters/detach/job";
import {
  createDetachSnapshot,
  importDetachSnapshot,
  verifyDetachSnapshot,
} from "@jazz/adapters/detach/snapshot";
import { encodeDetachBundle, receiveDetachBundle } from "@jazz/adapters/detach/transfer-protocol";
import { FileRunStore } from "@jazz/adapters/storage/run-store";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EVENT_POLL_MS = 250;
/** An idle attach still writes periodically, so a vanished client surfaces as EPIPE and exits. */
const EVENT_HEARTBEAT_MS = 15_000;

function incomingDirectory(): string {
  return path.join(getJazzHomeDirectory(), "detach", "incoming");
}

async function readStdinJson(): Promise<unknown> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += (chunk as Buffer).toString("utf8");
    if (data.length > 64 * 1024) {
      throw new Error("Detach request is too large");
    }
  }
  return JSON.parse(data) as unknown;
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error("Invalid handoff id");
  }
  return value;
}

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

/** Stage a verified file stream; retries with the same handoff id are idempotent. */
export async function receiveDetachedBundleCommand(): Promise<void> {
  const base = incomingDirectory();
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const temporary = path.join(base, `.incoming-${randomUUID()}`);
  try {
    await receiveDetachBundle(process.stdin, temporary);
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(temporary, "manifest.json"), "utf8"),
    );
    const handoffId = parseId(
      typeof raw === "object" && raw !== null
        ? (raw as { handoffId?: unknown }).handoffId
        : undefined,
    );
    const destination = path.join(base, handoffId);
    const existing = await fs
      .readFile(path.join(destination, "manifest.json"), "utf8")
      .catch(() => undefined);
    const manifestText = await fs.readFile(path.join(temporary, "manifest.json"), "utf8");
    if (existing === undefined) {
      await fs.rename(temporary, destination);
    } else if (existing !== manifestText) {
      throw new Error("Handoff id already contains a different snapshot");
    }
    process.stdout.write(JSON.stringify({ accepted: true, handoffId }));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

interface StartRequest {
  readonly handoffId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly workspacePath: string;
  readonly continuation: string;
  readonly approvalPolicy: "low-risk";
  readonly maxCostUSD: number;
  readonly maxDurationMs: number;
  readonly maxIterations: number;
}

function parseStartRequest(value: unknown): StartRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid detach start request");
  }
  const v = value as Record<string, unknown>;
  const handoffId = parseId(v["handoffId"]);
  const agentId = parseId(v["agentId"]);
  const conversationId = parseId(v["conversationId"]);
  const workspacePath = v["workspacePath"];
  if (
    typeof workspacePath !== "string" ||
    !path.isAbsolute(workspacePath) ||
    workspacePath.split(path.sep).includes("..") ||
    workspacePath.includes("\0")
  ) {
    throw new Error("Invalid remote workspace path");
  }
  const continuation = v["continuation"];
  if (typeof continuation !== "string" || !continuation.trim() || continuation.length > 16_000) {
    throw new Error("Invalid continuation instruction");
  }
  if (v["approvalPolicy"] !== "low-risk") {
    throw new Error("Invalid detached approval policy");
  }
  for (const key of ["maxCostUSD", "maxDurationMs", "maxIterations"] as const) {
    const number = v[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
      throw new Error(`Invalid ${key}`);
    }
  }
  return {
    handoffId,
    agentId,
    conversationId,
    workspacePath,
    continuation,
    approvalPolicy: "low-risk",
    maxCostUSD: v["maxCostUSD"] as number,
    maxDurationMs: v["maxDurationMs"] as number,
    maxIterations: v["maxIterations"] as number,
  };
}

/** Import once, then durably queue a remote continuation under the same conversation id. */
export async function startDetachedRunCommand(): Promise<void> {
  const request = parseStartRequest(await readStdinJson());
  const existing = await Effect.runPromise(readDetachedJob(request.handoffId));
  if (existing) {
    process.stdout.write(JSON.stringify({ accepted: true, handoffId: request.handoffId }));
    return;
  }
  const root = path.join(request.workspacePath, request.handoffId);
  if (await fs.lstat(root).catch(() => undefined)) {
    throw new Error(
      "Detached workspace already exists without a job record; inspect it before retrying",
    );
  }
  const bundleDirectory = path.join(incomingDirectory(), request.handoffId);
  const expected = await verifyDetachSnapshot(bundleDirectory);
  if (
    expected.handoffId !== request.handoffId ||
    expected.agentId !== request.agentId ||
    expected.conversationId !== request.conversationId
  ) {
    throw new Error("Handoff identity mismatch");
  }
  const manifest = await importDetachSnapshot({
    bundleDirectory,
    workspaceRoot: root,
  });
  if (
    manifest.handoffId !== request.handoffId ||
    manifest.agentId !== request.agentId ||
    manifest.conversationId !== request.conversationId
  ) {
    throw new Error("Imported handoff identity mismatch");
  }
  await Effect.runPromise(
    enqueueDetachedJob({
      handoffId: request.handoffId,
      agentId: request.agentId,
      conversationId: request.conversationId,
      workspacePath: request.workspacePath,
      workspaceRoot: root,
      continuation: request.continuation,
      approvalPolicy: request.approvalPolicy,
      maxCostUSD: request.maxCostUSD,
      maxDurationMs: request.maxDurationMs,
      maxIterations: request.maxIterations,
    }),
  );
  process.stdout.write(JSON.stringify({ accepted: true, handoffId: request.handoffId }));
}

/** Report the remote queue's fact about this handoff, without reading transcript text. */
export async function detachedRunStatusCommand(): Promise<void> {
  const input = await readStdinJson();
  const id = parseId(
    typeof input === "object" && input !== null
      ? (input as { handoffId?: unknown }).handoffId
      : undefined,
  );
  const job = await Effect.runPromise(readDetachedJob(id));
  if (!job) {
    throw new Error("Unknown detached run");
  }
  const state =
    job.status.kind === "pending"
      ? "preparing"
      : job.status.kind === "answer-pending" ||
          job.status.kind === "answer-running" ||
          job.status.kind === "message-pending" ||
          job.status.kind === "message-running"
        ? "running"
        : job.status.kind;
  let detail = job.status.kind === "failed" ? job.status.error : undefined;
  let approvalAvailable = false;
  if (job.status.kind === "parked") {
    const run = await Effect.runPromise(new FileRunStore().get(job.status.runId));
    if (run?.state.kind === "input-required" && run.state.pending.kind === "tool-approval") {
      const request = run.state.pending.request;
      detail = `${request.toolName}: ${request.message}`;
      approvalAvailable = true;
    } else {
      detail = `Run ${job.status.runId} requires input that detach v1 cannot answer`;
    }
  }
  process.stdout.write(JSON.stringify({ handoffId: id, state, detail, approvalAvailable }));
}

/** Persist a yes/no answer for the daemon to resume without depending on this SSH process. */
export async function answerDetachedRunCommand(approved: boolean): Promise<void> {
  const input = await readStdinJson();
  const id = parseId(
    typeof input === "object" && input !== null
      ? (input as { handoffId?: unknown }).handoffId
      : undefined,
  );
  const job = await Effect.runPromise(readDetachedJob(id));
  if (job?.status.kind === "parked") {
    const run = await Effect.runPromise(new FileRunStore().get(job.status.runId));
    if (run?.state.kind !== "input-required" || run.state.pending.kind !== "tool-approval") {
      throw new Error("This detached run is not awaiting tool approval");
    }
  }
  const record = await Effect.runPromise(queueDetachedAnswer(id, approved));
  process.stdout.write(
    JSON.stringify({ handoffId: id, accepted: true, state: record.status.kind }),
  );
}

async function streamResultSnapshot(record: DetachedJobRecord): Promise<void> {
  const id = record.input.handoffId;
  const directory = path.join(
    getJazzHomeDirectory(),
    "detach",
    "outgoing",
    `${id}-${randomUUID()}`,
  );
  try {
    await createDetachSnapshot({
      agentId: record.input.agentId,
      conversationId: record.input.conversationId,
      workspaceRoot: record.input.workspaceRoot,
      handoffId: id,
      bundleDirectory: directory,
    });
    await pipeline(encodeDetachBundle(directory), process.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Stream a completed remote workspace and conversation back for local conflict review. */
export async function pullDetachedRunCommand(): Promise<void> {
  const id = parseId(field(await readStdinJson(), "handoffId"));
  const record = await Effect.runPromise(readDetachedJob(id));
  if (!record || record.status.kind !== "completed") {
    throw new Error("Only completed detached runs can be pulled");
  }
  await streamResultSnapshot(record);
}

/**
 * Freeze the job so this host never runs it again, then stream the final state back.
 * Retrying after a dropped connection releases idempotently and streams the same state.
 */
export async function releaseDetachedRunCommand(): Promise<void> {
  const id = parseId(field(await readStdinJson(), "handoffId"));
  const record = await Effect.runPromise(releaseDetachedJob(id));
  await streamResultSnapshot(record);
}

/** Queue the operator's next message on a finished conversation. */
export async function messageDetachedRunCommand(): Promise<void> {
  const input = await readStdinJson();
  const id = parseId(field(input, "handoffId"));
  const text = field(input, "text");
  if (typeof text !== "string") {
    throw new Error("Invalid reply");
  }
  const record = await Effect.runPromise(queueDetachedMessage(id, text));
  process.stdout.write(
    JSON.stringify({ handoffId: id, accepted: true, state: record.status.kind }),
  );
}

/** Ask the remote worker to stop this handoff's current or queued turn. */
export async function cancelDetachedRunCommand(): Promise<void> {
  const id = parseId(field(await readStdinJson(), "handoffId"));
  const record = await Effect.runPromise(requestDetachedCancel(id));
  process.stdout.write(
    JSON.stringify({ handoffId: id, accepted: true, state: record.status.kind }),
  );
}

/**
 * Write the handoff's event log from a byte offset. With `follow`, keep tailing until the
 * SSH client goes away; the client tracks offsets itself, so reconnecting loses nothing.
 */
export async function detachedRunEventsCommand(): Promise<void> {
  const input = await readStdinJson();
  const id = parseId(field(input, "handoffId"));
  const sinceByte = field(input, "sinceByte");
  if (typeof sinceByte !== "number" || !Number.isSafeInteger(sinceByte) || sinceByte < 0) {
    throw new Error("Invalid event offset");
  }
  const follow = field(input, "follow") === true;
  if (!(await Effect.runPromise(readDetachedJob(id)))) {
    throw new Error("Unknown detached run");
  }
  let disconnected = false;
  process.stdout.on("error", () => {
    disconnected = true;
  });
  const write = (chunk: string) =>
    new Promise<void>((resolve) => {
      process.stdout.write(chunk, (error) => {
        if (error) {
          disconnected = true;
        }
        resolve();
      });
    });
  let offset = sinceByte;
  let lastWrite = Date.now();
  while (!disconnected) {
    const { lines, nextByte } = await readDetachEventLines(id, offset);
    if (lines.length > 0) {
      await write(`${lines.join("\n")}\n`);
      offset = nextByte;
      lastWrite = Date.now();
      continue;
    }
    if (!follow) {
      return;
    }
    if (Date.now() - lastWrite >= EVENT_HEARTBEAT_MS) {
      await write("\n");
      lastWrite = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
  }
}

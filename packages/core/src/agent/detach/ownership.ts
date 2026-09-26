/**
 * Durable, per-conversation ownership fence for remote handoff.
 *
 * `preparing` and `remote` both reject local execution. A transfer is retried by
 * its handoff id; another handoff cannot replace one that may already be live.
 * The remote imports data without this source-side record and becomes its sole
 * local writer. This is a safety fence, not a distributed lease: losing contact
 * with the remote never silently restores local write authority.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getJazzHomeDirectory } from "../../utils/paths";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

export interface DetachOwnership {
  readonly version: 1;
  readonly agentId: string;
  readonly conversationId: string;
  readonly handoffId: string;
  readonly targetHost: string;
  readonly state: "preparing" | "remote";
  readonly updatedAt: string;
}

function requireId(value: string, label: string): void {
  if (!ID.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function ownershipPath(agentId: string, conversationId: string): string {
  requireId(agentId, "agent id");
  requireId(conversationId, "conversation id");
  return path.join(getJazzHomeDirectory(), "detach", agentId, `${conversationId}.json`);
}

async function readRecord(file: string): Promise<DetachOwnership | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
      throw new Error("Invalid ownership record.");
    }
    const record = parsed as DetachOwnership;
    if (record.version !== 1 || (record.state !== "preparing" && record.state !== "remote")) {
      throw new Error("Invalid ownership record.");
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function withOwnershipLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out acquiring conversation ownership lock.", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rmdir(lock);
  }
}

async function writeRecord(file: string, record: DetachOwnership): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function prepareDetach(input: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly handoffId: string;
  readonly targetHost: string;
}): Promise<void> {
  requireId(input.handoffId, "handoff id");
  if (!input.targetHost.trim()) {
    throw new Error("Target host is required.");
  }
  const file = ownershipPath(input.agentId, input.conversationId);
  await withOwnershipLock(file, async () => {
    const existing = await readRecord(file);
    if (existing) {
      if (existing.handoffId === input.handoffId && existing.targetHost === input.targetHost) {
        return;
      }
      throw new Error("This conversation already has a remote handoff.");
    }
    await writeRecord(file, {
      version: 1,
      ...input,
      state: "preparing",
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function commitDetach(input: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly handoffId: string;
}): Promise<void> {
  const file = ownershipPath(input.agentId, input.conversationId);
  await withOwnershipLock(file, async () => {
    const record = await readRecord(file);
    if (!record || record.handoffId !== input.handoffId) {
      throw new Error("Handoff does not own this conversation.");
    }
    if (record.state === "remote") {
      return;
    }
    await writeRecord(file, { ...record, state: "remote", updatedAt: new Date().toISOString() });
  });
}

export async function abortDetach(input: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly handoffId: string;
}): Promise<void> {
  const file = ownershipPath(input.agentId, input.conversationId);
  await withOwnershipLock(file, async () => {
    const record = await readRecord(file);
    if (!record || record.handoffId !== input.handoffId) {
      throw new Error("Handoff does not own this conversation.");
    }
    if (record.state !== "preparing") {
      throw new Error("A committed handoff cannot be aborted locally.");
    }
    await fs.rm(file);
  });
}

/**
 * Return write authority to this machine after the remote host released the conversation
 * and its final state was imported. Only the handoff that holds the fence may lift it.
 */
export async function releaseDetach(input: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly handoffId: string;
}): Promise<void> {
  const file = ownershipPath(input.agentId, input.conversationId);
  await withOwnershipLock(file, async () => {
    const record = await readRecord(file);
    if (!record) {
      return;
    }
    if (record.handoffId !== input.handoffId) {
      throw new Error("Handoff does not own this conversation.");
    }
    if (record.state !== "remote") {
      throw new Error("Only a committed handoff can be reclaimed.");
    }
    await fs.rm(file);
  });
}

/**
 * Refuse writes to a conversation another machine owns. `heldBy` names the handoff doing the
 * write: reclaim imports the returned transcript while its own fence still stands.
 */
export async function assertConversationWritable(
  agentId: string,
  conversationId: string,
  heldBy?: string,
): Promise<void> {
  const record = await readRecord(ownershipPath(agentId, conversationId));
  if (record && record.handoffId !== heldBy) {
    throw new Error(
      `Conversation ${conversationId} is ${record.state} for remote host ${record.targetHost}.`,
    );
  }
}

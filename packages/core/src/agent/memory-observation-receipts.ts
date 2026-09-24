/**
 * Shadow-only memory opportunity receipts. Each scope-eligible entry gets a
 * bounded receipt without source text before a model request. A successful response
 * finalizes the same receipt with only exposures whose exact prompt or tool
 * result bytes survived into that request. Pending receipts survive crashes as
 * unknown observations; nothing here changes memory credit or agent behavior.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryEntryObservation } from "@/core/interfaces/memory-service";
import type { ChatMessage } from "@/core/types/message";
import { getJazzHomeDirectory } from "@/core/utils/paths";

const MAX_RECEIPTS_PER_ENTRY = 128;
const ENTRY_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 60_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptRoot(homeDirectory = getJazzHomeDirectory()): string {
  return path.join(homeDirectory, "memory-receipts");
}

function scopeRoot(scope: string, homeDirectory: string): string {
  if (!SCOPE_PATTERN.test(scope)) throw new Error("Invalid memory receipt scope.");
  return path.join(receiptRoot(homeDirectory), scope);
}

/** Read the generation that a memory snapshot must carry into receipt writes. */
export async function readMemoryReceiptEpoch(
  scope: string,
  homeDirectory = getJazzHomeDirectory(),
): Promise<string> {
  const file = path.join(scopeRoot(scope, homeDirectory), ".epoch");
  try {
    const epoch = (await fs.readFile(file, "utf8")).trim();
    if (!/^[a-f0-9-]{36}$/i.test(epoch)) throw new Error("Invalid memory receipt epoch.");
    return epoch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0";
    throw error;
  }
}

/** Serialize receipt creation and scope erasure across runs and processes. */
async function withScopeLock<A>(
  scope: string,
  homeDirectory: string,
  operation: () => Promise<A>,
): Promise<A> {
  if (!SCOPE_PATTERN.test(scope)) throw new Error("Invalid memory receipt scope.");
  const root = receiptRoot(homeDirectory);
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, `.lock-${scope}`);
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat !== undefined && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
      } else {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }
  if (!acquired) throw new Error("Memory receipt scope lock timed out.");
  try {
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function groupTickets(
  tickets: readonly MemoryOpportunityTicket[],
): Map<string, MemoryOpportunityTicket[]> {
  const groups = new Map<string, MemoryOpportunityTicket[]>();
  for (const ticket of tickets) {
    const key = `${ticket.homeDirectory}\u0000${ticket.entry.scope}`;
    const group = groups.get(key) ?? [];
    group.push(ticket);
    groups.set(key, group);
  }
  return groups;
}

/** A record of a model opportunity, not an assessment of memory usefulness. */
export interface MemoryOpportunityReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly entryId: string;
  readonly entryVersion: string;
  readonly pathAtOpportunity: string;
  readonly scope: string;
  readonly eligibility: "eligible" | "ineligible";
  readonly eligibilityEvidence: "scope_allowlist" | "view_memory_not_offered";
  readonly relevanceDecision: "unknown";
  readonly relevanceEvidence: readonly [];
  readonly opportunityId: string;
  readonly opportunityAt: string;
  readonly status: "pending" | "observed";
  readonly exposures: readonly {
    readonly kind: "injected" | "viewed";
    readonly modelRequestId: string;
    readonly deliveredVersion: string;
    readonly deliveredFingerprint: string;
    readonly at: string;
  }[];
  readonly sourceRefs: readonly string[];
}

export interface MemoryOpportunityTicket {
  readonly receipt: MemoryOpportunityReceipt;
  readonly entry: MemoryEntryObservation;
  readonly homeDirectory: string;
}

function receiptPath(receipt: MemoryOpportunityReceipt, homeDirectory: string): string {
  return path.join(
    receiptRoot(homeDirectory),
    receipt.scope,
    receipt.entryId,
    `${receipt.receiptId}.json`,
  );
}

async function storeReceipt(
  receipt: MemoryOpportunityReceipt,
  homeDirectory: string,
  overwrite = true,
): Promise<void> {
  if (!ENTRY_ID_PATTERN.test(receipt.entryId) || !SCOPE_PATTERN.test(receipt.scope)) return;
  const target = receiptPath(receipt, homeDirectory);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(receipt)}\n`, "utf8");
    if (overwrite) {
      await fs.rename(temp, target);
    } else {
      await fs.link(temp, target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  if (names.length <= MAX_RECEIPTS_PER_ENTRY) return;
  const dated = await Promise.all(
    names.map(async (name) => ({
      name,
      time: (await fs.stat(path.join(directory, name))).mtimeMs,
    })),
  );
  dated.sort((a, b) => a.time - b.time);
  await Promise.all(
    dated
      .slice(0, names.length - MAX_RECEIPTS_PER_ENTRY)
      .map(({ name }) => fs.rm(path.join(directory, name), { force: true })),
  );
}

/** Persist pending opportunities before the provider call; duplicate requests reuse IDs. */
export async function beginMemoryOpportunities(input: {
  readonly runId: string;
  readonly iteration: number;
  readonly entries: readonly MemoryEntryObservation[];
  readonly messages: readonly ChatMessage[];
  readonly homeDirectory?: string;
  readonly viewMemoryOffered?: boolean;
}): Promise<readonly MemoryOpportunityTicket[]> {
  const homeDirectory = input.homeDirectory ?? getJazzHomeDirectory();
  const requestFingerprint = digest(
    JSON.stringify(
      input.messages.map((message) => [message.role, message.content, message.tool_call_id]),
    ),
  );
  const opportunityId = digest(`${input.runId}:${input.iteration}:${requestFingerprint}`);
  const sourceRefs = [
    ...new Set(
      input.messages.flatMap((message) =>
        message.memorySource === undefined ? [] : [message.memorySource.id],
      ),
    ),
  ].slice(-8);
  const at = new Date().toISOString();
  const tickets = input.entries.map((entry) => {
    const receipt: MemoryOpportunityReceipt = {
      receiptId: digest(`${opportunityId}:${entry.entryId}:${entry.entryVersion}`),
      runId: input.runId,
      entryId: entry.entryId,
      entryVersion: entry.entryVersion,
      pathAtOpportunity: entry.path,
      scope: entry.scope,
      eligibility:
        entry.topic === undefined || input.viewMemoryOffered !== false ? "eligible" : "ineligible",
      eligibilityEvidence:
        entry.topic === undefined || input.viewMemoryOffered !== false
          ? "scope_allowlist"
          : "view_memory_not_offered",
      relevanceDecision: "unknown",
      relevanceEvidence: [],
      opportunityId,
      opportunityAt: at,
      status: "pending",
      exposures: [],
      sourceRefs,
    };
    return { receipt, entry, homeDirectory };
  });
  await Promise.all(
    [...groupTickets(tickets).values()].map(async (group) => {
      const scope = group[0]?.entry.scope;
      if (scope === undefined) return;
      await withScopeLock(scope, homeDirectory, async () => {
        const epoch = await readMemoryReceiptEpoch(scope, homeDirectory);
        for (const ticket of group) {
          if (ticket.entry.receiptEpoch === epoch) {
            await storeReceipt(ticket.receipt, homeDirectory, false);
          }
        }
      });
    }),
  );
  return tickets;
}

/** Finalize only after a model response confirms the request was accepted. */
export async function completeMemoryOpportunities(
  tickets: readonly MemoryOpportunityTicket[],
  messages: readonly ChatMessage[],
): Promise<void> {
  const at = new Date().toISOString();
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const systemLines = new Set(system.split("\n"));
  await Promise.all(
    [...groupTickets(tickets).values()].map(async (group) => {
      const scope = group[0]?.entry.scope;
      const homeDirectory = group[0]?.homeDirectory;
      if (scope === undefined || homeDirectory === undefined) return;
      await withScopeLock(scope, homeDirectory, async () => {
        const epoch = await readMemoryReceiptEpoch(scope, homeDirectory);
        for (const { receipt, entry } of group) {
          if (entry.receiptEpoch !== epoch) continue;
          const exposures: MemoryOpportunityReceipt["exposures"][number][] = [];
          const injectedLine = `- [${entry.scope}] ${entry.summary}`;
          if (entry.topic === undefined && systemLines.has(injectedLine)) {
            exposures.push({
              kind: "injected",
              modelRequestId: receipt.opportunityId,
              deliveredVersion: digest(injectedLine),
              deliveredFingerprint: digest(injectedLine),
              at,
            });
          }
          for (const message of messages) {
            const delivery = message.memoryDelivery;
            if (
              message.role !== "tool" ||
              message.cleared ||
              delivery?.path !== entry.path ||
              delivery.messageFingerprint !== digest(message.content)
            )
              continue;
            exposures.push({
              kind: "viewed",
              modelRequestId: receipt.opportunityId,
              deliveredVersion: delivery.deliveredVersion,
              deliveredFingerprint: delivery.deliveredFingerprint,
              at,
            });
          }
          await storeReceipt({ ...receipt, status: "observed", exposures }, homeDirectory);
        }
      });
    }),
  );
}

/** Read only the retained window for one entry, newest first. */
export async function readMemoryOpportunityReceipts(
  scope: string,
  entryId: string,
  limit = 5,
  homeDirectory = getJazzHomeDirectory(),
): Promise<readonly MemoryOpportunityReceipt[]> {
  if (!ENTRY_ID_PATTERN.test(entryId) || !SCOPE_PATTERN.test(scope)) return [];
  const directory = path.join(receiptRoot(homeDirectory), scope, entryId);
  const names = await fs.readdir(directory).catch(() => []);
  const receipts = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
          if (typeof parsed !== "object" || parsed === null) return undefined;
          const receipt = parsed as MemoryOpportunityReceipt;
          return receipt.entryId === entryId &&
            receipt.scope === scope &&
            typeof receipt.opportunityAt === "string"
            ? receipt
            : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return receipts
    .filter((receipt): receipt is MemoryOpportunityReceipt => receipt !== undefined)
    .sort((a, b) => b.opportunityAt.localeCompare(a.opportunityAt))
    .slice(0, Math.max(0, Math.min(limit, MAX_RECEIPTS_PER_ENTRY)));
}

/**
 * Forgetting any entry erases the scope's shadow receipts. This conservative
 * erasure still works if a provenance sidecar lost an old entry ID.
 */
export async function eraseMemoryOpportunityReceiptsForScope(
  scope: string,
  homeDirectory = getJazzHomeDirectory(),
): Promise<void> {
  await withScopeLock(scope, homeDirectory, async () => {
    const root = scopeRoot(scope, homeDirectory);
    await fs.mkdir(root, { recursive: true });
    const temp = path.join(root, `.epoch.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, `${randomUUID()}\n`, "utf8");
      await fs.rename(temp, path.join(root, ".epoch"));
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    const names = await fs.readdir(root);
    await Promise.all(
      names
        .filter((name) => name !== ".epoch")
        .map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })),
    );
  });
}

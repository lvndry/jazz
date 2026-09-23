/**
 * Shadow-only memory opportunity receipts. Each scope-eligible entry gets a
 * bounded, source-free receipt before a model request. A successful response
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptRoot(homeDirectory = getJazzHomeDirectory()): string {
  return path.join(homeDirectory, "memory-receipts");
}

/** A record of a model opportunity, not an assessment of memory usefulness. */
export interface MemoryOpportunityReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly entryId: string;
  readonly entryVersion: string;
  readonly pathAtOpportunity: string;
  readonly scope: string;
  readonly eligibility: "eligible";
  readonly eligibilityEvidence: "scope_allowlist";
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
): Promise<void> {
  if (!ENTRY_ID_PATTERN.test(receipt.entryId) || !SCOPE_PATTERN.test(receipt.scope)) return;
  const target = receiptPath(receipt, homeDirectory);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(receipt)}\n`, "utf8");
    await fs.rename(temp, target);
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
        message.trustedUserSource === undefined ? [] : [message.trustedUserSource.id],
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
      eligibility: "eligible",
      eligibilityEvidence: "scope_allowlist",
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
  await Promise.all(tickets.map(({ receipt }) => storeReceipt(receipt, homeDirectory)));
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
    tickets.map(({ receipt, entry, homeDirectory }) => {
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
      return storeReceipt({ ...receipt, status: "observed", exposures }, homeDirectory);
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
  if (!SCOPE_PATTERN.test(scope)) throw new Error("Invalid memory receipt scope.");
  await fs.rm(path.join(receiptRoot(homeDirectory), scope), { recursive: true, force: true });
}

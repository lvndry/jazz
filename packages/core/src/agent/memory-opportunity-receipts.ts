/**
 * Memory opportunity receipts. Before a model request, every scope-eligible
 * entry gets a pending receipt; once the provider accepts the request, the same
 * receipt is completed with the exposures whose exact bytes reached it. A
 * receipt holds paths, IDs and hashes, never entry or transcript text, and
 * nothing reads receipts to change agent behavior. A crash leaves a receipt
 * pending, which records that the outcome is unknown.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { MemoryEntrySnapshot } from "@/core/interfaces/memory-service";
import { formatPreferenceLine } from "@/core/memory/preference-line";
import type { ChatMessage } from "@/core/types/message";
import { toError } from "@/core/utils/errors";
import { sha256Hex } from "@/core/utils/hash";
import { getMemoryReceiptsDirectory } from "@/core/utils/paths";
import { isValidStorageKey, withLock, writeFileStringAtomic } from "@/core/utils/storage";

/** Newest receipts kept per entry; `jazz memory explain` reads within this window. */
export const MAX_RECEIPTS_PER_ENTRY = 128;

/** Receipts `jazz memory explain` shows unless asked for more. */
export const DEFAULT_RECEIPT_READ_LIMIT = 5;

/**
 * Receipts written to one entry between prunes. Pruning lists and stats the
 * whole directory, so it runs once per this many writes, and an entry holds at
 * most `MAX_RECEIPTS_PER_ENTRY + RECEIPT_WRITES_BETWEEN_PRUNES` files.
 */
export const RECEIPT_WRITES_BETWEEN_PRUNES = 32;

/** Before any forget, a scope's receipts carry this epoch. */
export const INITIAL_RECEIPT_EPOCH = "0";

const EPOCH_FILENAME = ".epoch";
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

type ReceiptEffect<A> = Effect.Effect<A, Error, FileSystem.FileSystem>;

function receiptScopeDirectory(scope: string, receiptsDirectory: string): ReceiptEffect<string> {
  return isValidStorageKey(scope)
    ? Effect.succeed(path.join(receiptsDirectory, scope))
    : Effect.fail(new Error("Invalid memory receipt scope."));
}

function scopeLockPath(scope: string, receiptsDirectory: string): string {
  return path.join(receiptsDirectory, `.lock-${scope}`);
}

/** Serialize receipt writes and scope erasure for one scope, across runs and processes. */
function withScopeLock<A>(
  scope: string,
  receiptsDirectory: string,
  operation: ReceiptEffect<A>,
): ReceiptEffect<A> {
  return receiptScopeDirectory(scope, receiptsDirectory).pipe(
    Effect.flatMap(() => withLock(scopeLockPath(scope, receiptsDirectory), operation)),
  );
}

function writeEpoch(fs: FileSystem.FileSystem, scopeDirectory: string): ReceiptEffect<string> {
  const epoch = randomUUID();
  return fs.makeDirectory(scopeDirectory, { recursive: true }).pipe(
    Effect.mapError(toError),
    Effect.zipRight(
      writeFileStringAtomic(fs, path.join(scopeDirectory, EPOCH_FILENAME), `${epoch}\n`, {
        tempPrefix: "memory-receipt-epoch",
      }),
    ),
    Effect.as(epoch),
  );
}

/**
 * The scope's epoch, read while its lock is held. An unreadable epoch is moved
 * aside and replaced, which invalidates every in-flight snapshot for the scope
 * instead of leaving receipts disabled until someone deletes the file.
 */
function readEpochLocked(scope: string, receiptsDirectory: string): ReceiptEffect<string> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scopeDirectory = yield* receiptScopeDirectory(scope, receiptsDirectory);
    const epochPath = path.join(scopeDirectory, EPOCH_FILENAME);
    const content = yield* fs.readFileString(epochPath).pipe(
      Effect.map((text): string | undefined => text.trim()),
      Effect.catchIf(
        (error) => error._tag === "SystemError" && error.reason === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError(toError),
    );
    if (content === undefined) {
      return INITIAL_RECEIPT_EPOCH;
    }
    if (UUID_PATTERN.test(content)) {
      return content;
    }
    yield* fs
      .rename(epochPath, `${epochPath}.corrupt-${Date.now()}`)
      .pipe(Effect.catchAll(() => Effect.void));
    return yield* writeEpoch(fs, scopeDirectory);
  });
}

/** The epoch a memory snapshot must carry for its receipts to be written. */
export function readMemoryReceiptEpoch(
  scope: string,
  receiptsDirectory = getMemoryReceiptsDirectory(),
): ReceiptEffect<string> {
  return withScopeLock(scope, receiptsDirectory, readEpochLocked(scope, receiptsDirectory));
}

/** Where a delivered view or injected line came from. */
export interface MemoryExposureRecord {
  readonly kind: "injected" | "viewed";
  /** sha256 of the entry text the model was shown. */
  readonly shownContentHash: string;
  /** Whether the whole entry was shown, rather than its summary line or a partial view. */
  readonly complete: boolean;
  readonly observedAt: string;
}

/** A record of a model opportunity, not an assessment of memory usefulness. */
export interface MemoryOpportunityReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly entryId: string;
  readonly entryContentHash: string;
  readonly pathAtOpportunity: string;
  readonly scope: string;
  readonly eligibility: "eligible" | "ineligible";
  readonly eligibilityEvidence: "scope_allowlist" | "view_memory_not_offered";
  readonly opportunityId: string;
  readonly opportunityAt: string;
  readonly status: "pending" | "completed";
  readonly exposures: readonly MemoryExposureRecord[];
}

export interface MemoryOpportunityTicket {
  readonly receipt: MemoryOpportunityReceipt;
  readonly entry: MemoryEntrySnapshot;
  readonly receiptsDirectory: string;
}

function receiptPath(receipt: MemoryOpportunityReceipt, receiptsDirectory: string): string {
  return path.join(receiptsDirectory, receipt.scope, receipt.entryId, `${receipt.receiptId}.json`);
}

/** Receipts written per entry directory since its last prune, for this process. */
const writesSincePrune = new Map<string, number>();

function pruneEntryDirectory(fs: FileSystem.FileSystem, directory: string): ReceiptEffect<void> {
  return Effect.gen(function* () {
    const names = (yield* fs.readDirectory(directory).pipe(Effect.mapError(toError))).filter(
      (name) => name.endsWith(".json"),
    );
    if (names.length <= MAX_RECEIPTS_PER_ENTRY) {
      return;
    }
    const dated = yield* Effect.forEach(names, (name) =>
      fs.stat(path.join(directory, name)).pipe(
        Effect.map((info) => ({
          name,
          modifiedAt: info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0,
        })),
        Effect.mapError(toError),
      ),
    );
    dated.sort((older, newer) => older.modifiedAt - newer.modifiedAt);
    yield* Effect.forEach(
      dated.slice(0, names.length - MAX_RECEIPTS_PER_ENTRY),
      ({ name }) => fs.remove(path.join(directory, name)).pipe(Effect.catchAll(() => Effect.void)),
      { discard: true },
    );
  });
}

/**
 * Write a receipt. A pending receipt never replaces an existing one, so a
 * retried request cannot reset a receipt its first attempt already completed.
 */
function storeReceipt(
  receipt: MemoryOpportunityReceipt,
  receiptsDirectory: string,
  replaceExisting: boolean,
): ReceiptEffect<void> {
  return Effect.gen(function* () {
    if (!UUID_PATTERN.test(receipt.entryId) || !isValidStorageKey(receipt.scope)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const target = receiptPath(receipt, receiptsDirectory);
    const directory = path.dirname(target);
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(toError));
    const content = `${JSON.stringify(receipt)}\n`;
    if (replaceExisting) {
      yield* writeFileStringAtomic(fs, target, content, { tempPrefix: "memory-receipt" });
    } else {
      const temporaryPath = path.join(directory, `.memory-receipt-${randomUUID()}.tmp`);
      yield* fs.writeFileString(temporaryPath, content).pipe(Effect.mapError(toError));
      yield* fs.link(temporaryPath, target).pipe(
        Effect.catchIf(
          (error) => error._tag === "SystemError" && error.reason === "AlreadyExists",
          () => Effect.void,
        ),
        Effect.mapError(toError),
        Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.catchAll(() => Effect.void))),
      );
    }
    const written = (writesSincePrune.get(directory) ?? RECEIPT_WRITES_BETWEEN_PRUNES) + 1;
    if (written > RECEIPT_WRITES_BETWEEN_PRUNES) {
      writesSincePrune.set(directory, 0);
      yield* pruneEntryDirectory(fs, directory);
    } else {
      writesSincePrune.set(directory, written);
    }
  });
}

/** Content hashes by message, reused while the message's content is unchanged. */
const contentHashByMessage = new WeakMap<
  ChatMessage,
  { readonly content: string; readonly hash: string }
>();

/** sha256 of a message's content, computed once per content rather than once per request. */
export function messageContentHash(message: ChatMessage): string {
  const cached = contentHashByMessage.get(message);
  if (cached !== undefined && cached.content === message.content) {
    return cached.hash;
  }
  const hash = sha256Hex(message.content);
  contentHashByMessage.set(message, { content: message.content, hash });
  return hash;
}

/** sha256 identifying one model request, built from per-message hashes so unchanged messages are not rehashed. */
export function requestContentHash(messages: readonly ChatMessage[]): string {
  return sha256Hex(
    messages
      .map(
        (message) => `${message.role}:${message.tool_call_id ?? ""}:${messageContentHash(message)}`,
      )
      .join("\n"),
  );
}

function groupTicketsByDirectoryAndScope(
  tickets: readonly MemoryOpportunityTicket[],
): readonly (readonly MemoryOpportunityTicket[])[] {
  const groups = new Map<string, MemoryOpportunityTicket[]>();
  for (const ticket of tickets) {
    const key = `${ticket.receiptsDirectory}\u0000${ticket.entry.scope}`;
    const group = groups.get(key) ?? [];
    group.push(ticket);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function forEachScopeGroup(
  tickets: readonly MemoryOpportunityTicket[],
  write: (ticket: MemoryOpportunityTicket) => ReceiptEffect<void>,
): ReceiptEffect<void> {
  return Effect.forEach(
    groupTicketsByDirectoryAndScope(tickets),
    (group) => {
      const first = group[0];
      if (first === undefined) {
        return Effect.void;
      }
      const { receiptsDirectory } = first;
      const scope = first.entry.scope;
      return withScopeLock(
        scope,
        receiptsDirectory,
        Effect.gen(function* () {
          const epoch = yield* readEpochLocked(scope, receiptsDirectory);
          for (const ticket of group) {
            if (ticket.entry.receiptEpoch === epoch) {
              yield* write(ticket);
            }
          }
        }),
      );
    },
    { concurrency: "unbounded", discard: true },
  );
}

export interface MemoryOpportunityRequest {
  readonly runId: string;
  readonly iteration: number;
  readonly entries: readonly MemoryEntrySnapshot[];
  readonly messages: readonly ChatMessage[];
  readonly viewMemoryOffered?: boolean;
  readonly receiptsDirectory?: string;
}

/** Persist pending receipts for a model request; a retried identical request reuses its IDs. */
export function beginMemoryOpportunities(
  request: MemoryOpportunityRequest,
): ReceiptEffect<readonly MemoryOpportunityTicket[]> {
  if (request.entries.length === 0) {
    return Effect.succeed([]);
  }
  const receiptsDirectory = request.receiptsDirectory ?? getMemoryReceiptsDirectory();
  const opportunityId = sha256Hex(
    `${request.runId}:${request.iteration}:${requestContentHash(request.messages)}`,
  );
  const opportunityAt = new Date().toISOString();
  const tickets = request.entries.map((entry): MemoryOpportunityTicket => {
    const eligible = entry.topic === undefined || request.viewMemoryOffered !== false;
    return {
      entry,
      receiptsDirectory,
      receipt: {
        receiptId: sha256Hex(`${opportunityId}:${entry.entryId}:${entry.entryContentHash}`),
        runId: request.runId,
        entryId: entry.entryId,
        entryContentHash: entry.entryContentHash,
        pathAtOpportunity: entry.path,
        scope: entry.scope,
        eligibility: eligible ? "eligible" : "ineligible",
        eligibilityEvidence: eligible ? "scope_allowlist" : "view_memory_not_offered",
        opportunityId,
        opportunityAt,
        status: "pending",
        exposures: [],
      },
    };
  });
  return forEachScopeGroup(tickets, (ticket) =>
    storeReceipt(ticket.receipt, ticket.receiptsDirectory, false),
  ).pipe(Effect.as(tickets));
}

/** Views that reached the request intact, by canonical memory path. */
function deliveredViewsByPath(
  messages: readonly ChatMessage[],
): ReadonlyMap<string, readonly NonNullable<ChatMessage["memoryDelivery"]>[]> {
  const views = new Map<string, NonNullable<ChatMessage["memoryDelivery"]>[]>();
  for (const message of messages) {
    const delivery = message.memoryDelivery;
    if (
      message.role !== "tool" ||
      message.cleared === true ||
      delivery === undefined ||
      delivery.messageContentHash !== messageContentHash(message)
    ) {
      continue;
    }
    const existing = views.get(delivery.path) ?? [];
    existing.push(delivery);
    views.set(delivery.path, existing);
  }
  return views;
}

/** Complete the receipts once a model response confirms the request was accepted. */
export function completeMemoryOpportunities(
  tickets: readonly MemoryOpportunityTicket[],
  messages: readonly ChatMessage[],
): ReceiptEffect<void> {
  if (tickets.length === 0) {
    return Effect.void;
  }
  const observedAt = new Date().toISOString();
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  const systemLines = new Set(systemPrompt.split("\n"));
  const viewsByPath = deliveredViewsByPath(messages);
  return forEachScopeGroup(tickets, ({ receipt, entry, receiptsDirectory }) => {
    const exposures: MemoryExposureRecord[] = [];
    const injectedLine = formatPreferenceLine(entry);
    if (entry.topic === undefined && systemLines.has(injectedLine)) {
      exposures.push({
        kind: "injected",
        shownContentHash: sha256Hex(entry.summary),
        complete: false,
        observedAt,
      });
    }
    for (const view of viewsByPath.get(entry.path) ?? []) {
      exposures.push({
        kind: "viewed",
        shownContentHash: view.shownContentHash,
        complete: view.complete,
        observedAt,
      });
    }
    return storeReceipt({ ...receipt, status: "completed", exposures }, receiptsDirectory, true);
  });
}

function parseReceipt(
  text: string,
  scope: string,
  entryId: string,
): MemoryOpportunityReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const receipt = parsed as MemoryOpportunityReceipt;
    return receipt.entryId === entryId &&
      receipt.scope === scope &&
      typeof receipt.opportunityAt === "string"
      ? receipt
      : undefined;
  } catch {
    return undefined;
  }
}

/** The newest receipts for one entry. A missing directory means none; other read errors fail. */
export function readMemoryOpportunityReceipts(
  scope: string,
  entryId: string,
  limit = DEFAULT_RECEIPT_READ_LIMIT,
  receiptsDirectory = getMemoryReceiptsDirectory(),
): ReceiptEffect<readonly MemoryOpportunityReceipt[]> {
  return Effect.gen(function* () {
    if (!UUID_PATTERN.test(entryId)) {
      return [];
    }
    const fs = yield* FileSystem.FileSystem;
    const scopeDirectory = yield* receiptScopeDirectory(scope, receiptsDirectory);
    const directory = path.join(scopeDirectory, entryId);
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (error) => error._tag === "SystemError" && error.reason === "NotFound",
        () => Effect.succeed([] as string[]),
      ),
      Effect.mapError(toError),
    );
    const receipts = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")),
      (name) =>
        fs.readFileString(path.join(directory, name)).pipe(
          Effect.map((text) => parseReceipt(text, scope, entryId)),
          Effect.catchAll(() => Effect.succeed(undefined)),
        ),
    );
    return receipts
      .filter((receipt): receipt is MemoryOpportunityReceipt => receipt !== undefined)
      .sort((earlier, later) => later.opportunityAt.localeCompare(earlier.opportunityAt))
      .slice(0, Math.max(0, Math.min(limit, MAX_RECEIPTS_PER_ENTRY)));
  });
}

/**
 * Forgetting any entry erases the scope's receipts and starts a new epoch, so an
 * in-flight snapshot cannot write them back. Erasing the whole scope still works
 * when the provenance sidecar lost an old entry's ID.
 */
export function eraseMemoryOpportunityReceiptsForScope(
  scope: string,
  receiptsDirectory = getMemoryReceiptsDirectory(),
): ReceiptEffect<void> {
  return withScopeLock(
    scope,
    receiptsDirectory,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scopeDirectory = yield* receiptScopeDirectory(scope, receiptsDirectory);
      yield* writeEpoch(fs, scopeDirectory);
      const names = yield* fs.readDirectory(scopeDirectory).pipe(Effect.mapError(toError));
      yield* Effect.forEach(
        names.filter((name) => name !== EPOCH_FILENAME),
        (name) =>
          fs
            .remove(path.join(scopeDirectory, name), { recursive: true })
            .pipe(Effect.mapError(toError)),
        { discard: true },
      );
    }),
  );
}

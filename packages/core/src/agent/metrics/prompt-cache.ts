/**
 * Prompt-cache observability: what a request's cacheable prefix looked like, how it differs from
 * the previous request of the same conversation, and how much of the input the provider served
 * from cache.
 *
 * Fingerprints are local hashes of what Jazz sends. A matching fingerprint says the prefix was
 * byte-identical to the last request; it does not prove the provider still held that prefix
 * (Anthropic expires cached prefixes after 5 minutes idle, so a slow human turn misses with a
 * perfect fingerprint). The provider's own cache-read count is the only evidence of a hit.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "@/core/types/tools";

export const CACHE_MISS_REASONS = [
  "first-request",
  "none",
  "tools-changed",
  "system-changed",
  "history-rewritten",
  "model-changed",
  "provider-changed",
] as const;

export type CacheMissReason = (typeof CACHE_MISS_REASONS)[number];

export type CacheChangedPart = "provider" | "model" | "tools" | "system" | "history";

/** Hex digits kept from a SHA-256 digest: 64 bits, ample to tell consecutive requests apart. */
const FINGERPRINT_HEX_LENGTH = 16;

/**
 * Below this share of input served from cache, most of the request was billed at the full input
 * rate, so the receipt names the likely cause next to the figure.
 */
export const LOW_CACHE_HIT_RATE = 0.5;

/** Conversations whose last request is remembered; the oldest is dropped past this. */
const MAX_TRACKED_CONVERSATIONS = 64;

export interface ToolFingerprintInput {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
}

export interface RequestFingerprint {
  readonly provider: string;
  readonly model: string;
  readonly toolsHash: string;
  readonly systemHash: string;
  /** One hash per persisted non-system message, in order. */
  readonly messageHashes: readonly string[];
  /** Hash of every persisted non-system message in the request. */
  readonly historyHash: string;
}

export interface FingerprintInput {
  readonly provider: string;
  readonly model: string;
  readonly tools: readonly ToolFingerprintInput[];
  readonly messages: readonly { readonly role: string; readonly kind?: string }[];
}

export interface CacheChange {
  readonly reason: CacheMissReason;
  readonly changed: readonly CacheChangedPart[];
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}

/** JSON with object keys sorted at every depth, so key order never changes a hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      return nested;
    }
    const record = nested as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = record[key];
    }
    return sorted;
  });
}

/**
 * Hash what the request sends, split by the order providers consume it: tools, then system,
 * then history. The ephemeral tail message is skipped because it is never part of the cached
 * prefix (it changes every step by design).
 */
export function fingerprintRequest(input: FingerprintInput): RequestFingerprint {
  const systemParts: string[] = [];
  const messageHashes: string[] = [];
  for (const message of input.messages) {
    if (message.kind === "ephemeral") {
      continue;
    }
    if (message.role === "system") {
      systemParts.push(JSON.stringify(message));
      continue;
    }
    messageHashes.push(digest(JSON.stringify(message)));
  }
  return {
    provider: input.provider,
    model: input.model,
    toolsHash: digest(canonicalJson(input.tools)),
    systemHash: digest(systemParts.join("\n")),
    messageHashes,
    historyHash: digest(messageHashes.join(",")),
  };
}

/**
 * The earliest-consumed part that changed, matching how providers build the cache key: a
 * change in tools invalidates system and history after it, so tools win over system, and system
 * over history. History counts as rewritten unless every message the previous request sent is
 * still there unchanged (a pure append only adds messages after them).
 */
export function classifyCacheChange(
  previous: RequestFingerprint | undefined,
  current: RequestFingerprint,
): CacheChange {
  if (previous === undefined) {
    return { reason: "first-request", changed: [] };
  }
  const changed: CacheChangedPart[] = [];
  if (previous.provider !== current.provider) {
    changed.push("provider");
  }
  if (previous.model !== current.model) {
    changed.push("model");
  }
  if (previous.toolsHash !== current.toolsHash) {
    changed.push("tools");
  }
  if (previous.systemHash !== current.systemHash) {
    changed.push("system");
  }
  const appended =
    previous.messageHashes.length <= current.messageHashes.length &&
    previous.messageHashes.every((hash, index) => hash === current.messageHashes[index]);
  if (!appended) {
    changed.push("history");
  }
  const [first] = changed;
  if (first === undefined) {
    return { reason: "none", changed };
  }
  const reasons: Record<CacheChangedPart, CacheMissReason> = {
    provider: "provider-changed",
    model: "model-changed",
    tools: "tools-changed",
    system: "system-changed",
    history: "history-rewritten",
  };
  return { reason: reasons[first], changed };
}

export type CacheUsageConvention = "subset" | "disjoint";

/**
 * Jazz's token usage comes from the AI SDK, which reports input tokens as the whole prompt with
 * cache reads and writes as parts of it, for every provider including Anthropic (whose raw API
 * reports them separately and which the SDK sums). Providers that report them disjointly are
 * normalized with `"disjoint"`.
 */
export const JAZZ_CACHE_USAGE_CONVENTION: CacheUsageConvention = "subset";

export interface CacheUsageInput {
  readonly promptTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface NormalizedCacheUsage {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalInputTokens: number;
}

/**
 * Split a request's input into uncached, cache-read and cache-write tokens. Returns undefined
 * when the provider reported neither cache field, which is "unknown", not a 0% hit rate.
 */
export function normalizeCacheUsage(
  usage: CacheUsageInput,
  convention: CacheUsageConvention = JAZZ_CACHE_USAGE_CONVENTION,
): NormalizedCacheUsage | undefined {
  if (usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) {
    return undefined;
  }
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens ?? 0);
  if (convention === "disjoint") {
    const uncachedInputTokens = Math.max(0, usage.promptTokens);
    return {
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalInputTokens: uncachedInputTokens + cacheReadTokens + cacheWriteTokens,
    };
  }
  const boundedRead = Math.min(cacheReadTokens, usage.promptTokens);
  const boundedWrite = Math.min(cacheWriteTokens, usage.promptTokens - boundedRead);
  return {
    uncachedInputTokens: usage.promptTokens - boundedRead - boundedWrite,
    cacheReadTokens: boundedRead,
    cacheWriteTokens: boundedWrite,
    totalInputTokens: usage.promptTokens,
  };
}

/** Cache reads over total input, 0..1, or undefined when unreported or the request had no input. */
export function cacheHitRate(
  usage: CacheUsageInput,
  convention: CacheUsageConvention = JAZZ_CACHE_USAGE_CONVENTION,
): number | undefined {
  const normalized = normalizeCacheUsage(usage, convention);
  if (normalized === undefined || normalized.totalInputTokens <= 0) {
    return undefined;
  }
  return normalized.cacheReadTokens / normalized.totalInputTokens;
}

/** Running cache totals over the requests that reported cache fields. */
export interface CacheTally {
  readonly reportedInputTokens: number;
  readonly reportedCacheReadTokens: number;
  readonly reportedRequests: number;
}

export const EMPTY_CACHE_TALLY: CacheTally = {
  reportedInputTokens: 0,
  reportedCacheReadTokens: 0,
  reportedRequests: 0,
};

export function addToCacheTally(
  tally: CacheTally,
  usage: CacheUsageInput,
  convention: CacheUsageConvention = JAZZ_CACHE_USAGE_CONVENTION,
): CacheTally {
  const normalized = normalizeCacheUsage(usage, convention);
  if (normalized === undefined) {
    return tally;
  }
  return {
    reportedInputTokens: tally.reportedInputTokens + normalized.totalInputTokens,
    reportedCacheReadTokens: tally.reportedCacheReadTokens + normalized.cacheReadTokens,
    reportedRequests: tally.reportedRequests + 1,
  };
}

export function cacheTallyHitRate(tally: CacheTally | undefined): number | undefined {
  if (tally === undefined || tally.reportedRequests === 0 || tally.reportedInputTokens <= 0) {
    return undefined;
  }
  return tally.reportedCacheReadTokens / tally.reportedInputTokens;
}

const WORDS_FOR_REASON: Readonly<Record<CacheMissReason, string>> = {
  "first-request": "first request",
  none: "prefix unchanged",
  "tools-changed": "tools changed",
  "system-changed": "system prompt changed",
  "history-rewritten": "history rewritten",
  "model-changed": "model changed",
  "provider-changed": "provider changed",
};

export function describeCacheReason(reason: CacheMissReason): string {
  return WORDS_FOR_REASON[reason];
}

/**
 * The cache figure for a summary line: `cache 82%`, `cache unknown` when no request reported
 * cache fields, and the last change's reason after a low rate. A rate with an unchanged prefix
 * is not blamed on the prompt, since the provider can evict a cached prefix on its own.
 */
export function formatCacheSummary(
  hitRate: number | undefined,
  reason: CacheMissReason | undefined,
): string {
  if (hitRate === undefined) {
    return "cache unknown";
  }
  const percent = `${String(Math.round(hitRate * 100))}%`;
  if (hitRate >= LOW_CACHE_HIT_RATE || reason === undefined) {
    return `cache ${percent}`;
  }
  return `cache ${percent} (${describeCacheReason(reason)})`;
}

export interface CacheObservation {
  readonly change: CacheChange;
  readonly hitRate: number | undefined;
}

interface LedgerEntry {
  fingerprint: RequestFingerprint;
  last: CacheObservation;
}

const ledger = new Map<string, LedgerEntry>();

/** The ledger key for a conversation, shared by the agent loop that writes it and `/context`. */
export function promptCacheKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

/**
 * Compare a request against the conversation's previous one and remember it. The change is
 * known before the response; `recordCacheUsage` attaches the hit rate once usage arrives.
 */
export function observeRequest(conversationKey: string, current: RequestFingerprint): CacheChange {
  const previous = ledger.get(conversationKey);
  const change = classifyCacheChange(previous?.fingerprint, current);
  ledger.delete(conversationKey);
  ledger.set(conversationKey, {
    fingerprint: current,
    last: { change, hitRate: undefined },
  });
  while (ledger.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = ledger.keys().next();
    if (oldest.done === true) {
      break;
    }
    ledger.delete(oldest.value);
  }
  return change;
}

/**
 * What {@link observeRequest} would classify for this request, without remembering it. Lets a
 * caller decide whether sending a request is worth it before the ledger records it as sent.
 */
export function peekCacheChange(conversationKey: string, current: RequestFingerprint): CacheChange {
  return classifyCacheChange(ledger.get(conversationKey)?.fingerprint, current);
}

export function recordCacheUsage(
  conversationKey: string,
  usage: CacheUsageInput,
): number | undefined {
  const entry = ledger.get(conversationKey);
  const hitRate = cacheHitRate(usage);
  if (entry !== undefined) {
    entry.last = { change: entry.last.change, hitRate };
  }
  return hitRate;
}

/** The conversation's most recent request, for `/context`. Undefined before any request. */
export function lastCacheObservation(conversationKey: string): CacheObservation | undefined {
  return ledger.get(conversationKey)?.last;
}

export function resetCacheLedger(): void {
  ledger.clear();
}

const toolSpecCache = new WeakMap<ToolDefinition, ToolFingerprintInput>();

/** A tool as the wire sees it: name, description and JSON schema, memoized per definition. */
export function toolFingerprintInput(tool: ToolDefinition): ToolFingerprintInput {
  const cached = toolSpecCache.get(tool);
  if (cached !== undefined) {
    return cached;
  }
  let schema: unknown;
  try {
    schema = tool.function.jsonSchema ?? z.toJSONSchema(tool.function.parameters);
  } catch {
    schema = null;
  }
  const input = { name: tool.function.name, description: tool.function.description, schema };
  toolSpecCache.set(tool, input);
  return input;
}

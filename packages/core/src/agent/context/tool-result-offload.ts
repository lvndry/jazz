/**
 * Persist large tool output outside the conversation so clearing can leave a
 * pointer instead of throwing the bytes away.
 *
 * Writes live under the conversation's work directory. A read-only home, a
 * locked-down container, or a CI image that can read but not write must not
 * fail the run: persist reports failure and the clearer falls back to a
 * "re-run the tool" stub. `clearWorkState` already deletes this directory.
 *
 * A body can also be written the moment its result is cut to fit the context, with the
 * provenance of what it holds beside it, so a page read back later is framed like the original.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import type { UntrustedProvenance } from "@/core/types/tools";
import { getWorkStateDirectory } from "@/core/utils/paths";
import { UNTRUSTED_TAG, hasExternalUntrustedFrame } from "@/core/utils/untrusted-content";
import { DEFAULT_TOKEN_COUNTER, type ModelHint, type TokenCounter } from "./token-counter";
import { MIN_CLEARABLE_RESULT_TOKENS } from "./tool-result-clearing";

const TOOL_RESULTS_DIRNAME = "tool-results";

/** Tool-call ids we will agree to use as filenames. Anything else is refused. */
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafeToolCallId(toolCallId: string): boolean {
  return SAFE_TOOL_CALL_ID.test(toolCallId);
}

export function toolResultsDirectory(agentId: string, conversationId: string): string {
  return path.join(getWorkStateDirectory(agentId, conversationId), TOOL_RESULTS_DIRNAME);
}

export function toolResultOffloadPath(
  agentId: string,
  conversationId: string,
  toolCallId: string,
): string {
  return path.join(toolResultsDirectory(agentId, conversationId), `${toolCallId}.txt`);
}

function provenancePath(agentId: string, conversationId: string, toolCallId: string): string {
  return path.join(toolResultsDirectory(agentId, conversationId), `${toolCallId}.provenance.json`);
}

/**
 * Write one tool body, and its provenance when it holds untrusted content. A body already
 * stored is kept: the first write is the whole result. Returns false on any filesystem error —
 * including EACCES / EROFS — and never throws.
 *
 * Synchronous so a run being stopped can still keep the result of a call it cut.
 */
export function writeToolResult(
  agentId: string,
  conversationId: string,
  toolCallId: string,
  content: string,
  provenance?: UntrustedProvenance,
): boolean {
  if (!isSafeToolCallId(toolCallId)) {
    return false;
  }
  try {
    mkdirSync(toolResultsDirectory(agentId, conversationId), { recursive: true, mode: 0o700 });
    if (provenance !== undefined) {
      writeFileSync(
        provenancePath(agentId, conversationId, toolCallId),
        JSON.stringify(provenance),
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    const target = toolResultOffloadPath(agentId, conversationId, toolCallId);
    if (!existsSync(target)) {
      writeFileSync(target, content, { encoding: "utf-8", mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

/** `writeToolResult` as an effect. */
export function persistToolResult(
  agentId: string,
  conversationId: string,
  toolCallId: string,
  content: string,
  provenance?: UntrustedProvenance,
): Effect.Effect<boolean, never, never> {
  return Effect.sync(() =>
    writeToolResult(agentId, conversationId, toolCallId, content, provenance),
  );
}

/**
 * Read a previously offloaded body. Missing, unreadable, or unsafe ids
 * return `undefined` rather than failing the run.
 */
export function readOffloadedToolResult(
  agentId: string,
  conversationId: string,
  toolCallId: string,
): Effect.Effect<string | undefined, never, never> {
  if (!isSafeToolCallId(toolCallId)) {
    return Effect.succeed(undefined);
  }

  return Effect.tryPromise({
    try: () => nodeFs.readFile(toolResultOffloadPath(agentId, conversationId, toolCallId), "utf-8"),
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

function isUntrustedProvenance(value: unknown): value is UntrustedProvenance {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, source } = value as Record<string, unknown>;
  return (kind === "external" || kind === "local-file") && typeof source === "string";
}

/**
 * What a stored body holds that came from outside: the provenance written beside it, or, for a
 * body stored with its envelope already around it, the kind of that envelope. Undefined when it
 * holds nothing untrusted.
 */
export function readOffloadedToolResultProvenance(
  agentId: string,
  conversationId: string,
  toolCallId: string,
  content: string,
): Effect.Effect<UntrustedProvenance | undefined, never, never> {
  if (!isSafeToolCallId(toolCallId)) {
    return Effect.succeed(undefined);
  }
  const framed = (): UntrustedProvenance | undefined => {
    if (!content.includes(`<${UNTRUSTED_TAG} `)) {
      return undefined;
    }
    return {
      kind: hasExternalUntrustedFrame(content) ? "external" : "local-file",
      source: `retrieve_tool_result ${toolCallId}`,
    };
  };
  return Effect.tryPromise({
    try: async (): Promise<unknown> =>
      JSON.parse(
        await nodeFs.readFile(provenancePath(agentId, conversationId, toolCallId), "utf-8"),
      ),
    catch: (error) => error,
  }).pipe(
    Effect.map((stored) => (isUntrustedProvenance(stored) ? stored : framed())),
    Effect.catchAll(() => Effect.succeed(framed())),
  );
}

export interface PersistLargeToolResultsOptions {
  readonly agentId: string;
  readonly conversationId: string;
  readonly modelHint: ModelHint;
  readonly tokenCounter?: TokenCounter;
  readonly minClearableTokens?: number;
}

/**
 * Write every large, still-verbatim tool result to disk.
 *
 * Returns the ids that are actually retrievable. A write failure for one
 * result does not skip the others, and an empty conversation id skips the
 * whole pass — there is nowhere to put the files.
 */
export function persistLargeToolResults(
  messages: readonly ChatMessage[],
  options: PersistLargeToolResultsOptions,
): Effect.Effect<ReadonlySet<string>, never, never> {
  if (options.conversationId.length === 0) {
    return Effect.succeed(new Set());
  }

  const counter = options.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
  const minTokens = options.minClearableTokens ?? MIN_CLEARABLE_RESULT_TOKENS;

  return Effect.gen(function* () {
    const retrievable = new Set<string>();
    for (const message of messages) {
      if (message.role !== "tool") continue;
      if (message.cleared) continue;
      const toolCallId = message.tool_call_id;
      if (!toolCallId || !isSafeToolCallId(toolCallId)) continue;
      if (counter.countMessage(message, options.modelHint) < minTokens) continue;

      const wrote = yield* persistToolResult(
        options.agentId,
        options.conversationId,
        toolCallId,
        message.content,
      );
      if (wrote) retrievable.add(toolCallId);
    }
    return retrievable;
  });
}

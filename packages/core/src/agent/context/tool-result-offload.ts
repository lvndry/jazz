/**
 * Persist large tool output outside the conversation so clearing can leave a
 * pointer instead of throwing the bytes away.
 *
 * Writes live under the conversation's work directory. A read-only home, a
 * locked-down container, or a CI image that can read but not write must not
 * fail the run: persist reports failure and the clearer falls back to a
 * "re-run the tool" stub. `clearWorkState` already deletes this directory.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { getWorkStateDirectory } from "@/core/utils/paths";
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

/**
 * Write one tool body. Returns false on any filesystem error — including
 * EACCES / EROFS — and never throws.
 */
export function persistToolResult(
  agentId: string,
  conversationId: string,
  toolCallId: string,
  content: string,
): Effect.Effect<boolean, never, never> {
  if (!isSafeToolCallId(toolCallId)) {
    return Effect.succeed(false);
  }

  return Effect.tryPromise({
    try: async () => {
      const directory = toolResultsDirectory(agentId, conversationId);
      await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = toolResultOffloadPath(agentId, conversationId, toolCallId);
      try {
        await nodeFs.access(target);
        return true;
      } catch {
        // Not there yet — write it.
      }
      await nodeFs.writeFile(target, content, { encoding: "utf-8", mode: 0o600 });
      return true;
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
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

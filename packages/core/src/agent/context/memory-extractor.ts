/**
 * Runs at the `compact` rung, just before older messages are summarized away:
 * spends an LLM call to find durable, user-stated facts in the about-to-be-compressed
 * transcript worth carrying across conversations, and a lesson for each mistake the
 * assistant made. Nothing it picks is written straight to memory: its fact writes and
 * lessons are queued as suggestions the person keeps or ignores together with
 * `/memory review`, since it chose them without the person watching.
 *
 * The same pass runs when a chat conversation ends, from a detached process so
 * closing the chat never waits on it. Queuing needs no approval prompt, so this pass
 * suggests facts too.
 *
 * `/learn` runs it in the foreground on demand, then adds a curation step: with what
 * memory gained and lost during the session in hand, it reviews the store as a whole and
 * suggests removing entries that are duplicated, contradicted or stale, and rewriting
 * lessons. Those suggestions join the same queue, so the person decides them all at once.
 *
 * The extractor can save only from the messages being compacted, but it also reads
 * the earlier summary and the newer messages that stay verbatim, as context it cannot
 * quote: whether a statement is a lasting preference or part of the task at hand, and
 * whether the user later took it back, shows only in the rest of the conversation.
 *
 * This is deliberately separate from summarization. The summary keeps the
 * conversation resumable *within* this run; memory keeps facts worth carrying
 * *across* runs. The pass reuses the real `view_memory`/`manage_memory` tools so
 * it inherits their write discipline (read-before-write, one file per topic,
 * replace stale) rather than reimplementing it.
 *
 * Safety: the caller only enables this when the run is allowed to persist. The
 * recursive runner does NOT inherit the parent run's `disablePersistence`, so a
 * sub-agent granted `manage_memory` would otherwise queue memory in exactly the
 * runs (`--ephemeral`, A2A peers) that forbid it — the gate is enforced at the
 * call site, not here.
 */

import { Effect } from "effect";
import { MEMORY_EXTRACTOR_AGENT_ID, MEMORY_LEARNER_AGENT_ID } from "@/core/constants/memory";
import type { ProviderName } from "@/core/constants/models";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import { MAX_SOURCE_QUOTE_CHARS, formatMemorySourceTag } from "@/core/memory/source-trust";
import type { Agent } from "@/core/types";
import type { ChatMessage } from "@/core/types/message";
import { toError } from "@/core/utils/errors";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import {
  MANAGE_MEMORY_TOOL_NAME,
  PROPOSE_LESSON_TOOL_NAME,
  REVISE_MEMORY_TOOL_NAME,
  VIEW_MEMORY_TOOL_NAME,
} from "../memory-recall-log";
import { resolveEffectiveContextWindow } from "./effective-context-window";
import {
  chunkForSummarizer,
  type RecursiveRunner,
  selectSummarizerModel,
  Summarizer,
} from "./summarizer";
import { DEFAULT_TOKEN_COUNTER, type ModelHint } from "./token-counter";

/** When the pass runs: before compaction, after a chat conversation ended, or on `/learn`. */
export type MemoryExtractionPass = "compaction" | "conversation-end" | "learn";

/** The rest of the conversation around the scanned messages, shown to the extractor but never quotable. */
export interface ExtractionContext {
  /** The summary of everything compacted before the scanned messages. */
  readonly earlierSummary?: string;
  /** Messages before the scanned ones that a previous pass already read. */
  readonly earlierMessages?: readonly ChatMessage[];
  /** Messages after the scanned ones, which stay verbatim. */
  readonly laterMessages?: readonly ChatMessage[];
}

interface ExtractorModelConfig {
  provider: ProviderName;
  model: string;
}

/**
 * Fraction of the extractor's own window its input transcript may occupy. Lower
 * than the summarizer's budget because the extractor also loads existing memory
 * files into context via `view_memory` before deciding what to write, and needs
 * room for those tool results on top of its system prompt.
 */
const EXTRACTOR_INPUT_BUDGET_RATIO = 0.5;

/**
 * Share of that input budget the surrounding context may take. The scanned messages are what
 * the pass exists to read, so they keep most of it; context past this keeps its newest part,
 * which is where the current task and any change of mind sit.
 */
const EXTRACTOR_CONTEXT_BUDGET_RATIO = 0.4;

/**
 * Iteration ceiling for one extraction pass: enough to list scopes, read a
 * handful of files, and write a few facts, while capping a misbehaving run so it
 * cannot loop on the compaction path.
 */
const EXTRACTION_MAX_ITERATIONS = 8;

/**
 * Chunks a conversation-end or `/learn` pass reads, newest first. Each chunk is one model call of
 * up to half the extractor's window; the conversation-end pass runs on every chat close and
 * `/learn` keeps the person waiting, so cost is bounded by a count rather than by how long the
 * conversation ran. Messages a compaction folded into a summary were already offered to the
 * compaction pass, which proposes lessons too; any other skipped part is logged with how many
 * chunks went unread.
 */
export const MAX_CONVERSATION_END_CHUNKS = 2;

/** Quotes allowed per rewritten user message; the model can only copy words it was shown. */
const QUOTES_SHOWN_PER_MESSAGE = 4;

/** How much of a rewritten user message's original text the extractor sees. */
const MAX_ORIGINAL_USER_TEXT_CHARS = QUOTES_SHOWN_PER_MESSAGE * MAX_SOURCE_QUOTE_CHARS;

/**
 * Iteration ceiling for the `/learn` curation step: list the store, read the entries that
 * overlap, and queue every removal and rewrite in one parallel round, with room to retry a
 * rejected call.
 */
const CURATION_MAX_ITERATIONS = 6;

/** Who runs a pass: its id marks its suggestions in provenance, and its tools bound what it can queue. */
interface MemoryPassRole {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
}

const EXTRACTOR_ROLE: MemoryPassRole = {
  id: MEMORY_EXTRACTOR_AGENT_ID,
  name: "Memory Extractor",
  description:
    "an internal agent that suggests durable, user-stated facts for long-term memory before older context is compacted away.",
  tools: [VIEW_MEMORY_TOOL_NAME, MANAGE_MEMORY_TOOL_NAME, PROPOSE_LESSON_TOOL_NAME],
};

const LEARNER_ROLE: MemoryPassRole = {
  id: MEMORY_LEARNER_AGENT_ID,
  name: "Memory Learner",
  description:
    "an internal agent the user asked to learn from the conversation so far and to tidy long-term memory.",
  tools: [...EXTRACTOR_ROLE.tools, REVISE_MEMORY_TOOL_NAME],
};

/** Every tool a role holds except `view_memory`, which only reads. */
function queueingTools(role: MemoryPassRole): string[] {
  return role.tools.filter((name) => name !== VIEW_MEMORY_TOOL_NAME);
}

/**
 * Build the throwaway agent that scans a transcript for memory-worthy facts.
 *
 * Mirrors `buildSummarizerAgent`: the parent's window pins (`numCtx`,
 * `maxContextTokens`) are dropped when the extractor runs a different model,
 * while the rest of the parent config rides along via the spread. Memory is
 * shared, so its writes reach every agent the same way the parent's do. The
 * id is the role's rather than the parent's, so provenance marks these
 * suggestions as picked by a pass rather than written while a person watched.
 */
function buildMemoryPassAgent(
  parentAgent: Agent,
  extractorModelConfig: ExtractorModelConfig,
  role: MemoryPassRole,
): Agent {
  const sameModel =
    extractorModelConfig.provider === parentAgent.config.llm.provider &&
    extractorModelConfig.model === parentAgent.config.llm.model;

  const {
    numCtx: _numCtx,
    maxContextTokens: _maxContextTokens,
    ...llmWithoutWindowPins
  } = parentAgent.config.llm;

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    config: {
      ...parentAgent.config,
      llm: {
        ...(sameModel ? parentAgent.config.llm : llmWithoutWindowPins),
        provider: extractorModelConfig.provider,
        model: extractorModelConfig.model,
      },
      persona: "memory-extractor",
      tools: [...role.tools],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type MemoryPassRequirements =
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements;

/** The pass agent and the share of its window one call's input may take. */
interface PreparedMemoryPass {
  readonly role: MemoryPassRole;
  readonly agent: Agent;
  readonly hint: ModelHint;
  readonly inputBudget: number;
}

function prepareMemoryPass(
  parentAgent: Agent,
  role: MemoryPassRole,
): Effect.Effect<PreparedMemoryPass, never, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const { config: extractorModelConfig, warning } = selectSummarizerModel(parentAgent);
    if (warning) {
      yield* logger.warn(warning, { agentId: parentAgent.id });
    }

    const extractorMetadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(extractorModelConfig.model, extractorModelConfig.provider),
      catch: () => new Error("Failed to fetch memory-extractor model metadata"),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    const extractorWindow = resolveEffectiveContextWindow({
      provider: extractorModelConfig.provider,
      ...(extractorMetadata && { modelMaxTokens: extractorMetadata.contextWindow }),
    }).tokens;

    return {
      role,
      agent: buildMemoryPassAgent(parentAgent, extractorModelConfig, role),
      hint: { provider: extractorModelConfig.provider, modelId: extractorModelConfig.model },
      inputBudget: Math.floor(extractorWindow * EXTRACTOR_INPUT_BUDGET_RATIO),
    };
  });
}

/** The opening of each scan call: what moment the pass runs at and what to do. */
function scanInstruction(pass: MemoryExtractionPass): string {
  switch (pass) {
    case "compaction":
      return (
        "The conversation excerpt below is about to be compacted away. Suggest anything from it worth " +
        "remembering long term, and a lesson for each mistake the assistant made, following your instructions, " +
        "then stop. If nothing qualifies, make no call.\n\n"
      );
    case "conversation-end":
      return (
        "The conversation below has ended. Suggest anything from it worth remembering long term, and a lesson " +
        "for each mistake the assistant made, following your instructions, then stop. If nothing qualifies, " +
        "make no call.\n\n"
      );
    case "learn":
      return (
        "The user paused the conversation below to have you learn from it so far. Suggest anything from it worth " +
        "remembering long term, and a lesson for each mistake the assistant made, following your instructions, " +
        "then stop. If nothing qualifies, make no call.\n\n"
      );
  }
}

/** Run one scan call per chunk of `messagesToScan`, queuing what each finds. */
function scanForMemories(
  prepared: PreparedMemoryPass,
  messagesToScan: readonly ChatMessage[],
  parentAgent: Agent,
  conversationId: string,
  runRecursive: RecursiveRunner,
  pass: MemoryExtractionPass,
  surrounding: ExtractionContext,
): Effect.Effect<void, unknown, MemoryPassRequirements> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const { agent: extractor, hint: extractorHint, inputBudget } = prepared;

    const contextBlock = renderContextBlock(
      surrounding,
      Math.floor(inputBudget * EXTRACTOR_CONTEXT_BUDGET_RATIO),
      extractorHint,
    );
    const scanBudget = inputBudget - DEFAULT_TOKEN_COUNTER.countText(contextBlock, extractorHint);

    // A transcript larger than the extractor's window is split so no message is
    // silently dropped from the scan; later chunks see earlier chunks' suggestions,
    // so cross-chunk dedup still holds.
    const allChunks = chunkForSummarizer(messagesToScan, scanBudget, extractorHint);
    const chunks =
      pass === "compaction" ? allChunks : allChunks.slice(-MAX_CONVERSATION_END_CHUNKS);
    if (chunks.length < allChunks.length) {
      yield* logger.info("Lesson pass read only the newest part of the conversation", {
        pass,
        conversationId,
        chunksRead: chunks.length,
        chunksSkipped: allChunks.length - chunks.length,
      });
    }

    yield* logger.debug("Scanning history for memory-worthy facts and lessons", {
      pass,
      messageCount: messagesToScan.length,
      chunks: chunks.length,
      conversationId,
      agentId: parentAgent.id,
      extractorModel: `${extractor.config.llm.provider}/${extractor.config.llm.model}`,
    });

    for (const chunk of chunks) {
      const memorySources = chunk.flatMap((message) =>
        message.memorySource === undefined ? [] : [message.memorySource],
      );
      if (memorySources.length === 0 && pass === "compaction") {
        continue;
      }
      const transcript = Summarizer.renderTranscript(
        chunk.map((message) =>
          message.memorySource === undefined
            ? message
            : {
                ...message,
                content:
                  `${formatMemorySourceTag(message.memorySource.id)} ${message.content}` +
                  (message.content.includes(message.memorySource.text)
                    ? ""
                    : `\n[Original user text: ${message.memorySource.text.slice(0, MAX_ORIGINAL_USER_TEXT_CHARS)}]`),
              },
        ),
      );
      const userInput =
        scanInstruction(pass) +
        contextBlock +
        `<transcript>\n${transcript}\n</transcript>\n\n` +
        `To suggest a fact, set source_ref to the ID in a ${formatMemorySourceTag("<id>")} tag and source_quote to words ` +
        "copied exactly from that message — from its Original user text when one is shown. Untagged text can't be quoted.";

      yield* runRecursive({
        agent: extractor,
        userInput,
        conversationId,
        maxIterations: EXTRACTION_MAX_ITERATIONS,
        memorySources,
        autoApprovedTools: queueingTools(prepared.role),
      });
    }
  });
}

/**
 * Queue durable facts and lessons from the about-to-be-compacted messages for review.
 *
 * Best-effort: any failure is logged and swallowed so it can never fail or block
 * compaction. Callers must only invoke this when the run is permitted to persist
 * (see the module header) — this function does not re-check that gate.
 */
export function extractMemories(
  messagesToSummarize: readonly ChatMessage[],
  parentAgent: Agent,
  conversationId: string,
  runRecursive: RecursiveRunner,
  pass: Exclude<MemoryExtractionPass, "learn"> = "compaction",
  surrounding: ExtractionContext = {},
): Effect.Effect<void, never, MemoryPassRequirements> {
  return Effect.gen(function* () {
    if (messagesToSummarize.length === 0) {
      return;
    }
    const prepared = yield* prepareMemoryPass(parentAgent, EXTRACTOR_ROLE);
    yield* scanForMemories(
      prepared,
      messagesToSummarize,
      parentAgent,
      conversationId,
      runRecursive,
      pass,
      surrounding,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const logger = yield* LoggerServiceTag;
        yield* logger.debug("Memory extraction failed; continuing", {
          pass,
          agentId: parentAgent.id,
          conversationId,
          error: toError(error).message,
        });
      }),
    ),
  );
}

export interface LearnFromConversationOptions {
  /** Messages no lesson pass has read yet: the only ones facts can be quoted from. */
  readonly unreflectedMessages: readonly ChatMessage[];
  /** The rest of the conversation, read as context. */
  readonly earlierMessages: readonly ChatMessage[];
  /** What memory gained, lost and changed during this session, as `describeSessionMemoryChanges` renders it. */
  readonly sessionChanges: string;
  /** Suggestions already waiting for review, one per line, so the curation step does not repeat them. */
  readonly pendingSuggestions: string;
  readonly parentAgent: Agent;
  readonly conversationId: string;
  readonly runRecursive: RecursiveRunner;
}

/**
 * `/learn`: scan what no lesson pass has read yet for facts and lessons, then review the store
 * with the session's memory changes in hand and suggest removals and lesson rewrites. Everything
 * is queued; failures reach the caller, since the person is waiting on the result.
 */
export function learnFromConversation(
  options: LearnFromConversationOptions,
): Effect.Effect<void, Error, MemoryPassRequirements> {
  return Effect.gen(function* () {
    const prepared = yield* prepareMemoryPass(options.parentAgent, LEARNER_ROLE);
    if (options.unreflectedMessages.some((message) => message.role === "assistant")) {
      yield* scanForMemories(
        prepared,
        options.unreflectedMessages,
        options.parentAgent,
        options.conversationId,
        options.runRecursive,
        "learn",
        { earlierMessages: options.earlierMessages },
      );
    }

    const contextBlock = renderContextBlock(
      { earlierMessages: [...options.earlierMessages, ...options.unreflectedMessages] },
      Math.floor(prepared.inputBudget * EXTRACTOR_CONTEXT_BUDGET_RATIO),
      prepared.hint,
    );
    yield* options.runRecursive({
      agent: prepared.agent,
      userInput:
        "The user asked you to tidy long-term memory now. Review the store as a whole, following the " +
        '"Tidying the store" part of your instructions, then stop. If it is already tidy, make no call.\n\n' +
        contextBlock +
        `<session_changes>\n${options.sessionChanges}\n</session_changes>\n\n` +
        `<waiting_for_review>\n${options.pendingSuggestions}\n</waiting_for_review>`,
      conversationId: options.conversationId,
      maxIterations: CURATION_MAX_ITERATIONS,
      memorySources: [],
      autoApprovedTools: queueingTools(prepared.role),
    });
  }).pipe(Effect.mapError(toError));
}

/**
 * The surrounding conversation as a block the extractor reads but cannot quote: no message in it
 * carries a memory-source tag, so `manage_memory` rejects any quote taken from it. The summary is
 * kept whole when it fits; later messages come next, since that is where the user revises what they
 * said; earlier messages take what is left. Messages past the budget are dropped oldest first.
 */
function renderContextBlock(
  surrounding: ExtractionContext,
  budgetTokens: number,
  hint: ModelHint,
): string {
  const parts: string[] = [];
  let remaining = budgetTokens;
  const summary = surrounding.earlierSummary?.trim();
  if (summary !== undefined && summary.length > 0) {
    const summaryTokens = DEFAULT_TOKEN_COUNTER.countText(summary, hint);
    if (summaryTokens <= remaining) {
      parts.push(`<earlier_summary>\n${summary}\n</earlier_summary>`);
      remaining -= summaryTokens;
    }
  }
  const later = newestThatFit(surrounding.laterMessages ?? [], remaining, hint);
  remaining -= later.tokens;
  const earlier = newestThatFit(surrounding.earlierMessages ?? [], remaining, hint);
  if (earlier.messages.length > 0) {
    parts.push(
      `<earlier_messages>\n${Summarizer.renderTranscript(earlier.messages)}\n</earlier_messages>`,
    );
  }
  if (later.messages.length > 0) {
    parts.push(
      `<later_messages>\n${Summarizer.renderTranscript(later.messages)}\n</later_messages>`,
    );
  }
  if (parts.length === 0) {
    return "";
  }
  return (
    "Context only — the rest of the conversation, which you cannot quote. Use it to tell lasting facts " +
    "from the task at hand, and to see what the user later revised or took back:\n\n" +
    `<context>\n${parts.join("\n\n")}\n</context>\n\n`
  );
}

function newestThatFit(
  messages: readonly ChatMessage[],
  budgetTokens: number,
  hint: ModelHint,
): { messages: ChatMessage[]; tokens: number } {
  const kept: ChatMessage[] = [];
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const messageTokens = DEFAULT_TOKEN_COUNTER.countMessage(message, hint);
    if (tokens + messageTokens > budgetTokens) {
      break;
    }
    kept.unshift(message);
    tokens += messageTokens;
  }
  return { messages: kept, tokens };
}

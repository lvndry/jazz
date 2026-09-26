/**
 * Runs at the `compact` rung, just before older messages are summarized away:
 * spends an LLM call to persist any durable, user-stated facts from the
 * about-to-be-compressed transcript into long-term memory, so they survive the
 * conversation even though their verbatim source does not.
 *
 * This is deliberately separate from summarization. The summary keeps the
 * conversation resumable *within* this run; memory keeps facts worth carrying
 * *across* runs. The pass reuses the real `view_memory`/`manage_memory` tools so
 * it inherits their write discipline (read-before-write, one file per topic,
 * replace stale) rather than reimplementing it.
 *
 * Safety: the caller only enables this when the run is allowed to persist. The
 * recursive runner does NOT inherit the parent run's `disablePersistence`, so a
 * sub-agent granted `manage_memory` would otherwise write memory in exactly the
 * runs (`--ephemeral`, A2A peers) that forbid it — the gate is enforced at the
 * call site, not here.
 */

import { Effect } from "effect";
import { MEMORY_EXTRACTOR_AGENT_ID } from "@/core/constants/memory";
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
import { MANAGE_MEMORY_TOOL_NAME, VIEW_MEMORY_TOOL_NAME } from "../memory-recall-log";
import { resolveEffectiveContextWindow } from "./effective-context-window";
import {
  chunkForSummarizer,
  type RecursiveRunner,
  selectSummarizerModel,
  Summarizer,
} from "./summarizer";
import type { ModelHint } from "./token-counter";

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
 * Iteration ceiling for one extraction pass: enough to list scopes, read a
 * handful of files, and write a few facts, while capping a misbehaving run so it
 * cannot loop on the compaction path.
 */
const EXTRACTION_MAX_ITERATIONS = 8;

/** Quotes allowed per rewritten user message; the model can only copy words it was shown. */
const QUOTES_SHOWN_PER_MESSAGE = 4;

/** How much of a rewritten user message's original text the extractor sees. */
const MAX_ORIGINAL_USER_TEXT_CHARS = QUOTES_SHOWN_PER_MESSAGE * MAX_SOURCE_QUOTE_CHARS;

/**
 * Build the throwaway agent that scans a transcript for memory-worthy facts.
 *
 * Mirrors `buildSummarizerAgent`: the parent's window pins (`numCtx`,
 * `maxContextTokens`) are dropped when the extractor runs a different model, but
 * the parent's `config.memoryScopes` rides along via the spread so writes land
 * in the parent's scopes. The id stays `"memory-extractor"` rather than the
 * parent's, so provenance marks these writes as auto-extracted rather than
 * user-directed.
 */
function buildMemoryExtractorAgent(
  parentAgent: Agent,
  extractorModelConfig: ExtractorModelConfig,
): Agent {
  const sameModel =
    extractorModelConfig.provider === parentAgent.config.llmProvider &&
    extractorModelConfig.model === parentAgent.config.llmModel;

  const {
    numCtx: _numCtx,
    maxContextTokens: _maxContextTokens,
    ...configWithoutWindowPins
  } = parentAgent.config;

  return {
    id: MEMORY_EXTRACTOR_AGENT_ID,
    name: "Memory Extractor",
    description:
      "an internal agent that saves durable, user-stated facts to long-term memory before older context is compacted away.",
    config: {
      ...(sameModel ? parentAgent.config : configWithoutWindowPins),
      llmProvider: extractorModelConfig.provider,
      llmModel: extractorModelConfig.model,
      persona: "memory-extractor",
      tools: [VIEW_MEMORY_TOOL_NAME, MANAGE_MEMORY_TOOL_NAME],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Persist durable facts from the about-to-be-compacted messages into memory.
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
): Effect.Effect<
  void,
  never,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    if (messagesToSummarize.length === 0) {
      return;
    }

    const { config: extractorModelConfig, warning } = selectSummarizerModel(parentAgent);
    if (warning) {
      yield* logger.warn(warning, { agentId: parentAgent.id });
    }

    const extractor = buildMemoryExtractorAgent(parentAgent, extractorModelConfig);

    const extractorHint: ModelHint = {
      provider: extractorModelConfig.provider,
      modelId: extractorModelConfig.model,
    };
    const extractorMetadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(extractorModelConfig.model, extractorModelConfig.provider),
      catch: () => new Error("Failed to fetch memory-extractor model metadata"),
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const extractorWindow = resolveEffectiveContextWindow({
      provider: extractorModelConfig.provider,
      ...(extractorMetadata && { modelMaxTokens: extractorMetadata.contextWindow }),
    }).tokens;
    const inputBudget = Math.floor(extractorWindow * EXTRACTOR_INPUT_BUDGET_RATIO);

    // A transcript larger than the extractor's window is split so no message is
    // silently dropped from the scan; later chunks see earlier chunks' writes,
    // so cross-chunk dedup still holds.
    const chunks = chunkForSummarizer(messagesToSummarize, inputBudget, extractorHint);

    yield* logger.debug("Scanning history for memory-worthy facts before compaction", {
      messageCount: messagesToSummarize.length,
      chunks: chunks.length,
      conversationId,
      agentId: parentAgent.id,
      extractorModel: `${extractorModelConfig.provider}/${extractorModelConfig.model}`,
    });

    for (const chunk of chunks) {
      const memorySources = chunk.flatMap((message) =>
        message.memorySource === undefined ? [] : [message.memorySource],
      );
      if (memorySources.length === 0) {
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
        "The conversation excerpt below is about to be compacted away. Persist anything from it worth " +
        "remembering long term, following your instructions, then stop. If nothing qualifies, make no changes.\n\n" +
        `<transcript>\n${transcript}\n</transcript>\n\n` +
        `To write memory, set source_ref to the ID in a ${formatMemorySourceTag("<id>")} tag and source_quote to words ` +
        "copied exactly from that message — from its Original user text when one is shown. Untagged text can't be quoted.";

      yield* runRecursive({
        agent: extractor,
        userInput,
        conversationId,
        maxIterations: EXTRACTION_MAX_ITERATIONS,
        memorySources,
      });
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const logger = yield* LoggerServiceTag;
        yield* logger.debug("Memory extraction before compaction failed; continuing", {
          agentId: parentAgent.id,
          conversationId,
          error: toError(error).message,
        });
      }),
    ),
  );
}

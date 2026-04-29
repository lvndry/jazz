import type { ProviderName } from "@/core/constants/models";

/**
 * Output of a single parser feed/flush call.
 *
 * The parser splits a streaming text delta into visible text and thinking text.
 * Either field may be empty. `thinkingStarted` and `thinkingEnded` flag the
 * boundaries of a thinking region so the stream processor can emit the
 * corresponding `thinking_start` / `thinking_complete` events.
 */
export interface ParseChunk {
  readonly visibleText: string;
  readonly thinkingText: string;
  readonly thinkingStarted?: boolean;
  readonly thinkingEnded?: boolean;
}

/**
 * Stateful parser for one streaming request. Implementations buffer across
 * `feed()` calls so a tag split across chunk boundaries is stitched correctly.
 */
export interface ReasoningParser {
  feed(textDelta: string): ParseChunk;
  flush(): ParseChunk;
}

/**
 * Inputs to parser selection. Comes from ModelInfo plus the resolved provider
 * name. `chatTemplate` and `capabilities` may be undefined (cloud providers).
 */
export interface ParserSelectionContext {
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly chatTemplate?: string;
  readonly capabilities?: readonly string[];
}

/**
 * A factory that knows whether it can handle a given model and constructs
 * fresh parser instances per request.
 */
export interface ReasoningParserFactory {
  readonly id: string;
  canHandle(ctx: ParserSelectionContext): boolean;
  create(): ReasoningParser;
}

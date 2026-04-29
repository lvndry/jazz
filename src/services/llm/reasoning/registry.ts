import { TagPairParserFactory } from "./tag-pair-parser";
import type { ParserSelectionContext, ReasoningParser, ReasoningParserFactory } from "./types";

/**
 * Parser factories ordered from most-specific to least-specific. The first
 * factory whose canHandle() returns true wins. Add new parsers (Harmony,
 * Hermes, etc.) above TagPairParserFactory.
 */
const PARSER_FACTORIES: readonly ReasoningParserFactory[] = [
  // HarmonyParserFactory,   // future: Group 2
  // HermesParserFactory,    // future: Group 3
  TagPairParserFactory,
];

export function selectParser(ctx: ParserSelectionContext): ReasoningParser | null {
  for (const factory of PARSER_FACTORIES) {
    if (factory.canHandle(ctx)) return factory.create();
  }
  return null;
}

/**
 * True when any registered parser would claim this model — i.e. the model
 * emits in-band reasoning tags. Used by the model fetcher to derive
 * `isReasoningModel` for local providers whose models aren't in models.dev.
 * Auto-extends as new parser factories are added to PARSER_FACTORIES.
 */
export function hasReasoningParser(ctx: ParserSelectionContext): boolean {
  return PARSER_FACTORIES.some((factory) => factory.canHandle(ctx));
}

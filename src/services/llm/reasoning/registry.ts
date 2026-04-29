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

import { TagPairParser, TagPairParserFactory } from "./tag-pair-parser";
import type { ParserSelectionContext, ReasoningParser, ReasoningParserFactory } from "./types";

const PARSER_FACTORIES: readonly ReasoningParserFactory[] = [
  // HarmonyParserFactory,   // future: Group 2
  // HermesParserFactory,    // future: Group 3
  TagPairParserFactory,
];

/**
 * Return the parser to run against a model's stream. When a registered factory
 * explicitly claims the context, that parser wins. Otherwise we fall back to a
 * defensive TagPairParser instance: it's a passthrough on plain text and only
 * acts when it actually sees a `<think>` / `<thinking>` open tag. Many local
 * models emit those tags at runtime without surfacing them in the chat
 * template or capabilities, so a strict factory gate silently leaks reasoning
 * into the response. The one format we explicitly refuse to passthrough is
 * Harmony (`<|channel|>analysis`), where TagPairParser would visibly mangle
 * the channel/message delimiters.
 */
export function selectParser(ctx: ParserSelectionContext): ReasoningParser | null {
  for (const factory of PARSER_FACTORIES) {
    if (factory.canHandle(ctx)) return factory.create();
  }
  if (ctx.chatTemplate && /<\|channel\|>analysis/.test(ctx.chatTemplate)) return null;
  return new TagPairParser();
}

/**
 * True when any registered parser would claim this model — i.e. the model is
 * metadata-declared as emitting in-band reasoning tags. Used by the model
 * fetcher to derive `isReasoningModel` for local providers whose models
 * aren't in models.dev. Stays strict so the UI/metadata only flags genuine
 * reasoning models, even though `selectParser` runs the parser more
 * permissively at runtime.
 */
export function hasReasoningParser(ctx: ParserSelectionContext): boolean {
  return PARSER_FACTORIES.some((factory) => factory.canHandle(ctx));
}

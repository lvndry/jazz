/**
 * Ollama model discovery for the `/model` picker, shared by the Discord and
 * Telegram bridges.
 *
 * Goes through `@jazz/adapters`'s `ModelFetcherService` — the same model
 * listing, `/api/show` capability probing, and models.dev cross-referencing
 * the CLI's own model picker uses — rather than each bridge making its own
 * simplified `/tags`/`/show` calls. In particular, reasoning support comes
 * from `resolveOllamaToolSupport`/`hasReasoningParser`'s full precedence
 * rules (live `/api/show` capabilities, then models.dev, then legacy
 * `/api/tags` metadata), not a bare `capabilities.includes("thinking")`
 * check.
 *
 * Ollama is the only provider Jazz's bridges can introspect for free — its
 * local HTTP API lists installed models without an API key or a round-trip
 * to a hosted catalog, which is why `/model` offers it as a live picker. Any
 * other provider Jazz supports still works, just via an explicit
 * `provider/model` argument rather than a browsable list — see each
 * bridge's `/model` handling.
 */

import { createModelFetcher } from "@jazz/adapters/llm/model-fetcher";
import { Effect } from "effect";

const modelFetcher = createModelFetcher();

export interface OllamaModelChoice {
  readonly id: string;
  readonly isReasoningModel: boolean;
}

export async function listOllamaModels(ollamaBaseUrl: string): Promise<OllamaModelChoice[]> {
  const models = await Effect.runPromise(
    modelFetcher
      .fetchModels("ollama", ollamaBaseUrl, "/tags")
      .pipe(Effect.catchAll(() => Effect.succeed([]))),
  );
  return [...models]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({ id: model.id, isReasoningModel: model.isReasoningModel === true }));
}

/**
 * Model listing for the `/model` picker, shared by the Discord and Telegram
 * bridges. Wraps `@jazz/adapters`'s `listModelsForProvider` — the same
 * models.dev / live-endpoint listing the CLI's own model picker uses —
 * resolving the provider's API key from the environment, since a bridge has
 * no `AgentConfigService` of its own.
 */

import { listModelsForProvider as listModelsForProviderShared } from "@jazz/adapters/llm/model-fetcher";
import { LLM_PROVIDER_ENV_VARS } from "@jazz/adapters/secrets/registry";
import type { ProviderName } from "@jazz/core/constants/models";
import { Effect } from "effect";

export interface ProviderModelChoice {
  readonly id: string;
  readonly isReasoningModel: boolean;
}

export async function listModelsForProvider(
  provider: ProviderName,
): Promise<ProviderModelChoice[]> {
  const apiKey = process.env[LLM_PROVIDER_ENV_VARS[provider] ?? ""];
  const models = await Effect.runPromise(
    listModelsForProviderShared(provider, { apiKey }).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    ),
  );
  return [...models]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({ id: model.id, isReasoningModel: model.isReasoningModel === true }));
}

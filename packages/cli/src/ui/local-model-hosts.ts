/**
 * Resolve the host and port shown beside a local model in the conversation header.
 * URLs come from the same LLM service resolver used by requests; only the URL's
 * host reaches UI state, so credentials, paths, and query values stay out of it.
 */

import {
  isLocalServerProvider,
  LOCAL_MODEL_PROVIDERS,
  type LocalServerProvider,
} from "@jazz/core/constants/local-providers";
import { isOllamaCloudModel } from "@jazz/core/constants/ollama";
import type { LLMService } from "@jazz/core/interfaces/llm";
import type { LLMConfig } from "@jazz/core/types/config";

export type LocalModelHosts = Readonly<Partial<Record<LocalServerProvider, string>>>;

/** Resolve all four local provider endpoints once when a conversation starts. */
export function resolveLocalModelHosts(
  llmService: Pick<LLMService, "resolveLocalProviderBaseUrl">,
  config: LLMConfig | undefined,
): LocalModelHosts {
  const hosts: Partial<Record<LocalServerProvider, string>> = {};
  for (const provider of LOCAL_MODEL_PROVIDERS) {
    try {
      const url = new URL(llmService.resolveLocalProviderBaseUrl(provider, config));
      if (url.host) hosts[provider] = url.host;
    } catch {
      // A malformed endpoint is diagnosed by the model request, not the header.
    }
  }
  return hosts;
}

/** No local address is shown for cloud models, including Ollama's cloud tags. */
export function hostForModel(
  provider: string | undefined,
  model: string | undefined,
  hosts: LocalModelHosts | undefined,
): string | undefined {
  if (
    provider === undefined ||
    model === undefined ||
    !isLocalServerProvider(provider) ||
    (provider === "ollama" && isOllamaCloudModel(model))
  ) {
    return undefined;
  }
  return hosts?.[provider];
}

/** Which model providers have a credential, from config, a ChatGPT sign-in, or the environment. */

import { LLM_PROVIDER_ENV_VARS, llmProviderApiKeyFromEnv } from "@jazz/core/secrets/registry";
import type { AppConfig } from "@jazz/core/types/index";
import { isChatGPTSignedIn } from "@jazz/core/utils/provider-model";

export function configuredProviderNames(config: AppConfig): string[] {
  const names: string[] = [];
  const llm = config.llm;
  if (llm !== undefined) {
    for (const [name, value] of Object.entries(llm)) {
      if (value === undefined || typeof value !== "object") continue;
      const key = (value as { api_key?: unknown }).api_key;
      if (typeof key === "string" && key.length > 0) names.push(name);
    }
  }
  if (isChatGPTSignedIn(llm)) {
    names.push("chatgpt");
  }
  for (const provider of Object.keys(LLM_PROVIDER_ENV_VARS)) {
    const fromEnv = llmProviderApiKeyFromEnv(provider);
    if (fromEnv !== undefined && !names.includes(provider)) {
      names.push(provider);
    }
  }
  return names;
}

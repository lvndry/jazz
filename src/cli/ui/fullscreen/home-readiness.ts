import type { AppConfig } from "@/core/types/index";
import { LLM_PROVIDER_ENV_VARS } from "@/services/secrets/registry";
import type { HomeRequirement } from "./screens/Home";

export interface HomeReadinessInput {
  readonly agentCount: number;
}

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
  for (const [provider, envVar] of Object.entries(LLM_PROVIDER_ENV_VARS)) {
    const fromEnv = process.env[envVar];
    if (fromEnv !== undefined && fromEnv.length > 0 && !names.includes(provider)) {
      names.push(provider);
    }
  }
  return names;
}

export function homeRequirements(input: HomeReadinessInput): readonly HomeRequirement[] {
  const agentReady = input.agentCount > 0;
  const agentDetail =
    input.agentCount === 0
      ? "none yet"
      : input.agentCount === 1
        ? "1 of them"
        : `${String(input.agentCount)} of them`;

  return [
    {
      label: "agent",
      ready: agentReady,
      detail: agentDetail,
      ...(agentReady ? {} : { remedy: "create your first one below" }),
    },
  ];
}

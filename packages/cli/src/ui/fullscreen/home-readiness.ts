import { LLM_PROVIDER_ENV_VARS } from "@jazz/adapters/secrets/registry";
import type { AppConfig } from "@jazz/core/types/index";
import { systemInfo } from "@jazz/core/utils/system-info";
import type { HomeFact, HomeRequirement } from "./screens/Home";

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
  const agentDetail = input.agentCount === 0 ? "none yet" : String(input.agentCount);

  return [
    {
      label: "agents",
      ready: agentReady,
      detail: agentDetail,
      ...(agentReady ? {} : { remedy: "create your first one below" }),
    },
  ];
}

/**
 * The machine facts every agent is grounded with, condensed to the four rows
 * the home screen shows. Same source as the system prompt's `Environment:`
 * block, so what the wizard reports is exactly what agents are told.
 */
export function homeEnvironmentFacts(): readonly HomeFact[] {
  const info = systemInfo();
  return [
    { label: "date", detail: info.currentDate },
    { label: "os", detail: `${info.osInfo} · ${info.shell} · ${info.username}` },
    { label: "cwd", detail: info.cwd },
    { label: "hardware", detail: info.hardware },
  ];
}

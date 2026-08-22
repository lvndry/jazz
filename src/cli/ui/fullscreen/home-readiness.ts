import type { AppConfig } from "@/core/types/index";
import { LLM_PROVIDER_ENV_VARS } from "@/services/secrets/registry";
import type { ConnectorStatus } from "../store";
import type { HomeRequirement } from "./screens/Home";

export interface HomeReadinessInput {
  readonly configuredProviders: readonly string[];
  readonly preferredProvider?: string;
  readonly preferredModel?: string;
  readonly agentCount: number;
  readonly connectors: ReadonlyMap<string, ConnectorStatus>;
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

function connectorNames(
  connectors: ReadonlyMap<string, ConnectorStatus>,
): readonly { readonly name: string; readonly live: boolean }[] {
  const rows: { readonly name: string; readonly live: boolean }[] = [];
  for (const [name, status] of connectors) {
    if (name === undefined) continue;
    rows.push({ name, live: status === "live" });
  }
  return rows;
}

export function homeRequirements(input: HomeReadinessInput): readonly HomeRequirement[] {
  const providerName = input.preferredProvider ?? input.configuredProviders[0];
  const providerReady = providerName !== undefined;
  const providerDetail =
    providerName === undefined
      ? "no key yet"
      : input.preferredModel === undefined
        ? providerName
        : `${providerName}, ${input.preferredModel}`;

  const agentReady = input.agentCount > 0;
  const agentDetail =
    input.agentCount === 0
      ? "none yet"
      : input.agentCount === 1
        ? "1 of them"
        : `${String(input.agentCount)} of them`;

  const apps = connectorNames(input.connectors);
  const liveApps = apps.filter((app) => app.live).length;
  const appsReady = liveApps > 0;
  const appsDetail = appsReady
    ? liveApps === apps.length
      ? `${String(liveApps)} connected`
      : `${String(liveApps)} of ${String(apps.length)} connected`
    : "none connected";

  return [
    {
      label: "provider",
      ready: providerReady,
      detail: providerDetail,
      ...(providerReady ? {} : { remedy: "add a key with jazz config" }),
    },
    {
      label: "agent",
      ready: agentReady,
      detail: agentDetail,
      ...(agentReady ? {} : { remedy: "create your first one below" }),
    },
    {
      label: "apps",
      ready: appsReady,
      detail: appsDetail,
      ...(appsReady ? {} : { remedy: "optional, add later" }),
    },
  ];
}

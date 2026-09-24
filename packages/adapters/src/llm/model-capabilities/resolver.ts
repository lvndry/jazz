/**
 * Pure resolution of model capabilities from independent sources.
 *
 * The resolver retains per-field provenance because a local server can be
 * authoritative for tools while the Jazz registry is authoritative for the
 * reasoning request shape. It does not fetch, read configuration, or serialize
 * provider options; callers supply already-validated observations and overrides.
 */

import type { ProviderName } from "@jazz/core/constants/models";
import type { ReasoningControlSurface } from "@jazz/core/types/model-capabilities";
import {
  BUILTIN_MODEL_CAPABILITY_REGISTRY,
  isTransportValidForProvider,
  type CapabilityProfile,
  type ModelCapabilityRegistry,
} from "./registry";

export type CapabilitySource =
  "unknown" | "catalog" | "provider-default" | "builtin-model" | "live" | "operator";

export interface CatalogCapabilities {
  readonly supportsReasoning?: boolean;
  readonly supportsTools?: boolean;
}

export interface ResolvedModelCapabilities {
  readonly reasoning: ReasoningControlSurface | { readonly kind: "unknown" };
  readonly supportsTools?: boolean;
  readonly source: {
    readonly reasoning: CapabilitySource;
    readonly tools: CapabilitySource;
  };
}

export interface ResolveModelCapabilitiesInput {
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly catalog?: CatalogCapabilities;
  /** Facts observed from the actual local deployment, such as `/api/show` or `/props`. */
  readonly live?: CapabilityProfile;
  /** A validated operator override for this exact provider/model deployment. */
  readonly operator?: CapabilityProfile;
  /** Dependency injection keeps tests and future registry editions deterministic. */
  readonly registry?: ModelCapabilityRegistry;
}

function controlIsSafeForProvider(
  provider: ProviderName,
  control: ReasoningControlSurface | undefined,
): control is ReasoningControlSurface {
  if (!control) return false;
  if (control.kind === "unsupported") return true;
  return isTransportValidForProvider(provider, control.transport);
}

function catalogReasoning(
  catalog: CatalogCapabilities | undefined,
): ReasoningControlSurface | { readonly kind: "unknown" } {
  if (catalog?.supportsReasoning === false) return { kind: "unsupported" };
  // Models.dev's true means reasoning exists, not how Jazz can control it.
  return { kind: "unknown" };
}

function pickReasoning(
  provider: ProviderName,
  catalog: CatalogCapabilities | undefined,
  providerDefault: CapabilityProfile | undefined,
  model: CapabilityProfile | undefined,
  live: CapabilityProfile | undefined,
  operator: CapabilityProfile | undefined,
): Pick<ResolvedModelCapabilities, "reasoning" | "source"> {
  const candidates: readonly [CapabilitySource, CapabilityProfile | undefined][] = [
    ["operator", operator],
    ["live", live],
    ["builtin-model", model],
    ["provider-default", providerDefault],
  ];
  for (const [source, profile] of candidates) {
    if (controlIsSafeForProvider(provider, profile?.reasoning)) {
      return { reasoning: profile.reasoning, source: { reasoning: source, tools: "unknown" } };
    }
  }
  return {
    reasoning: catalogReasoning(catalog),
    source: {
      reasoning: catalog?.supportsReasoning === undefined ? "unknown" : "catalog",
      tools: "unknown",
    },
  };
}

function pickTools(
  catalog: CatalogCapabilities | undefined,
  providerDefault: CapabilityProfile | undefined,
  model: CapabilityProfile | undefined,
  live: CapabilityProfile | undefined,
  operator: CapabilityProfile | undefined,
): Pick<ResolvedModelCapabilities, "supportsTools" | "source"> {
  const candidates: readonly [CapabilitySource, CapabilityProfile | undefined][] = [
    ["operator", operator],
    ["live", live],
    ["builtin-model", model],
    ["provider-default", providerDefault],
  ];
  for (const [source, profile] of candidates) {
    if (profile?.supportsTools !== undefined) {
      return {
        supportsTools: profile.supportsTools,
        source: { reasoning: "unknown", tools: source },
      };
    }
  }
  return {
    ...(catalog?.supportsTools !== undefined ? { supportsTools: catalog.supportsTools } : {}),
    source: {
      reasoning: "unknown",
      tools: catalog?.supportsTools === undefined ? "unknown" : "catalog",
    },
  };
}

/**
 * Resolve controls with a fixed, inspectable precedence:
 * operator > live deployment > exact built-in model > provider default > catalog.
 *
 * The precedence is evaluated independently for reasoning and tools. Invalid
 * transport/provider pairs are ignored rather than passed to a provider.
 */
export function resolveModelCapabilities(
  input: ResolveModelCapabilitiesInput,
): ResolvedModelCapabilities {
  const registry: ModelCapabilityRegistry = input.registry ?? BUILTIN_MODEL_CAPABILITY_REGISTRY;
  const provider = registry[input.provider];
  const model = provider?.models?.[input.modelId];
  const reasoning = pickReasoning(
    input.provider,
    input.catalog,
    provider?.default,
    model,
    input.live,
    input.operator,
  );
  const tools = pickTools(input.catalog, provider?.default, model, input.live, input.operator);

  return {
    reasoning: reasoning.reasoning,
    ...(tools.supportsTools !== undefined ? { supportsTools: tools.supportsTools } : {}),
    source: { reasoning: reasoning.source.reasoning, tools: tools.source.tools },
  };
}

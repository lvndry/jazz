/**
 * Declarative model-control profiles owned by the LLM adapter.
 *
 * Models.dev tells Jazz whether a model broadly supports reasoning and tools,
 * but it deliberately does not describe provider request controls. This module
 * holds only those controls: sparse exact-model exceptions plus provider
 * defaults. A profile never contains raw provider options, so adding an
 * operator override cannot become a request-body injection mechanism.
 */

import type { ProviderName } from "@jazz/core/constants/models";
import type {
  ReasoningControlSurface,
  ReasoningTransport,
} from "@jazz/core/types/model-capabilities";

/** Alias the portable core contract used by config and the UI. */
export type ReasoningControl = ReasoningControlSurface;

/** A partial profile is intentional: sources independently know tools/reasoning. */
export interface CapabilityProfile {
  readonly reasoning?: ReasoningControl;
  readonly supportsTools?: boolean;
}

export interface ProviderCapabilityRegistry {
  readonly default?: CapabilityProfile;
  /** Exact provider-facing IDs only. Family-name and bare-ID matching is unsafe here. */
  readonly models?: Readonly<Record<string, CapabilityProfile>>;
}

export type ModelCapabilityRegistry = Readonly<
  Partial<Record<ProviderName, ProviderCapabilityRegistry>>
>;

/**
 * Built-in request-control knowledge. Keep this intentionally sparse: entries
 * exist only where a provider/model's control surface is verified. A missing
 * entry means unknown, never unsupported.
 */
export const BUILTIN_MODEL_CAPABILITY_REGISTRY = {
  openai: {
    models: {
      "gpt-5.1": {
        reasoning: {
          kind: "effort",
          efforts: ["low", "medium", "high"],
          canDisable: true,
          transport: "openai.responses.reasoning-effort",
        },
      },
    },
  },
  anthropic: {
    models: {
      "claude-opus-4-5": {
        reasoning: {
          kind: "manual",
          minimumBudgetTokens: 1024,
          canDisable: true,
          transport: "anthropic.messages.extended-thinking",
        },
      },
    },
  },
  ollama: {
    default: {
      reasoning: {
        kind: "toggle",
        canDisable: true,
        transport: "ollama.chat.think",
      },
    },
  },
  llamacpp: {
    default: {
      reasoning: {
        kind: "toggle",
        canDisable: true,
        transport: "llamacpp.chat.enable-thinking",
      },
    },
  },
  vllm: {
    default: {
      reasoning: {
        kind: "effort",
        efforts: ["low", "medium", "high"],
        canDisable: true,
        transport: "vllm.chat.reasoning-effort",
      },
    },
  },
} as const satisfies ModelCapabilityRegistry;

/**
 * A config parser should reject transport/provider mismatches before this
 * module sees them. This defensive runtime check also protects direct callers
 * and prevents a valid closed transport from leaking to the wrong adapter.
 */
export function isTransportValidForProvider(
  provider: ProviderName,
  transport: ReasoningTransport,
): boolean {
  switch (provider) {
    case "openai":
      return transport === "openai.responses.reasoning-effort";
    case "anthropic":
      return (
        transport === "anthropic.messages.extended-thinking" ||
        transport === "anthropic.messages.adaptive-thinking"
      );
    case "ollama":
      return transport === "ollama.chat.think";
    case "llamacpp":
      return (
        transport === "llamacpp.chat.enable-thinking" ||
        transport === "llamacpp.chat.thinking-budget"
      );
    case "vllm":
      return transport === "vllm.chat.reasoning-effort";
    default:
      return false;
  }
}

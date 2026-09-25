/**
 * Model capability-control contracts.
 *
 * These types describe the closed set of reasoning controls Jazz can safely
 * expose and serialize. Adapters own the registry and request serialization;
 * this module owns only the pure configuration boundary shared by the runtime,
 * configuration reader, and UI.
 */

/** Effort names understood by one or more Jazz-owned reasoning transports. */
export const CAPABILITY_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CapabilityReasoningEffort = (typeof CAPABILITY_REASONING_EFFORTS)[number];

/**
 * An agent's requested reasoning behaviour. This is deliberately provider-neutral:
 * the capability resolver checks it against the selected model and the adapter turns
 * the resulting closed transport into provider options.
 */
export type ReasoningSelection = "disable" | CapabilityReasoningEffort;

/** Whether a structured reasoning selection is syntactically safe to persist. */
export function isReasoningSelection(value: unknown): value is ReasoningSelection {
  return (
    value === "disable" ||
    (typeof value === "string" &&
      (CAPABILITY_REASONING_EFFORTS as readonly string[]).includes(value))
  );
}

/** True unless an agent explicitly asked the model not to reason. */
export function reasoningIsEnabled(selection: ReasoningSelection | undefined): boolean {
  return selection !== undefined && selection !== "disable";
}

/** Compact user-facing description for renderers and status surfaces. */
export function describeReasoningSelection(selection: ReasoningSelection | undefined): string {
  return selection ?? "default";
}

/**
 * A provider-specific request encoding which Jazz has implemented and tested.
 *
 * This is deliberately a closed union rather than an arbitrary request-body
 * escape hatch: configuration may select a known transport but cannot inject
 * unreviewed provider options.
 */
export type ReasoningTransport =
  | "openai.responses.reasoning-effort"
  | "anthropic.messages.extended-thinking"
  | "anthropic.messages.adaptive-thinking"
  | "ollama.chat.think"
  | "llamacpp.chat.enable-thinking"
  | "llamacpp.chat.thinking-budget"
  | "vllm.chat.reasoning-effort";

/**
 * The controls an exact provider-facing model ID accepts.
 *
 * A capability override replaces Jazz's built-in profile for the selected
 * property; its transport is still restricted to a Jazz-owned implementation.
 */
export type ReasoningControlSurface =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "toggle";
      readonly transport: "ollama.chat.think" | "llamacpp.chat.enable-thinking";
      readonly canDisable: boolean;
    }
  | {
      readonly kind: "effort";
      readonly transport: "openai.responses.reasoning-effort" | "vllm.chat.reasoning-effort";
      readonly efforts: readonly CapabilityReasoningEffort[];
      readonly canDisable: boolean;
    }
  | {
      readonly kind: "manual";
      readonly transport: "anthropic.messages.extended-thinking";
      readonly minimumBudgetTokens: number;
      readonly maximumBudgetTokens?: number;
      readonly efforts?: readonly CapabilityReasoningEffort[];
      readonly canDisable: boolean;
    }
  | {
      readonly kind: "adaptive";
      readonly transport: "anthropic.messages.adaptive-thinking";
      readonly efforts: readonly CapabilityReasoningEffort[];
      readonly canDisable: boolean;
    }
  | {
      readonly kind: "budget";
      readonly transport: "llamacpp.chat.thinking-budget";
      readonly minimumBudgetTokens: number;
      readonly maximumBudgetTokens?: number;
      readonly canDisable: boolean;
    };

/**
 * One operator correction for an exact provider-facing model ID.
 *
 * Omitted properties intentionally mean "unknown/no correction", not false.
 */
export interface ModelCapabilityOverride {
  readonly reasoning?: ReasoningControlSurface;
  readonly supportsTools?: boolean;
}

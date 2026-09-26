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
 * A request encoding which Jazz has implemented and tested.
 *
 * This is deliberately a closed union rather than an arbitrary request-body
 * escape hatch: configuration may select a known transport but cannot inject
 * unreviewed provider options.
 *
 * `openai-compatible.*` transports describe the chat-completions wire rather
 * than a vendor, so any provider Jazz reaches through an OpenAI-compatible
 * client (llama.cpp, vLLM, SGLang, NVIDIA NIM, OrcaRouter) can use them:
 * - `reasoning-effort` sends top-level `reasoning_effort`, `"none"` to disable.
 * - `template-enable-thinking` sends `chat_template_kwargs.enable_thinking`.
 * - `template-thinking-budget` sends `chat_template_kwargs.thinking_budget`.
 */
export type ReasoningTransport =
  | "openai.responses.reasoning-effort"
  | "anthropic.messages.extended-thinking"
  | "anthropic.messages.adaptive-thinking"
  | "ollama.chat.think"
  | "openai-compatible.chat.reasoning-effort"
  | "openai-compatible.chat.template-enable-thinking"
  | "openai-compatible.chat.template-thinking-budget";

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
      readonly transport: "ollama.chat.think" | "openai-compatible.chat.template-enable-thinking";
      readonly canDisableReasoning: boolean;
    }
  | {
      readonly kind: "effort";
      readonly transport:
        "openai.responses.reasoning-effort" | "openai-compatible.chat.reasoning-effort";
      readonly efforts: readonly CapabilityReasoningEffort[];
      readonly canDisableReasoning: boolean;
    }
  | {
      readonly kind: "manual";
      readonly transport: "anthropic.messages.extended-thinking";
      readonly minimumBudgetTokens: number;
      readonly maximumBudgetTokens?: number;
      readonly efforts?: readonly CapabilityReasoningEffort[];
      readonly canDisableReasoning: boolean;
    }
  | {
      readonly kind: "adaptive";
      readonly transport: "anthropic.messages.adaptive-thinking";
      readonly efforts: readonly CapabilityReasoningEffort[];
      readonly canDisableReasoning: boolean;
    }
  | {
      readonly kind: "budget";
      readonly transport: "openai-compatible.chat.template-thinking-budget";
      readonly minimumBudgetTokens: number;
      readonly maximumBudgetTokens?: number;
      readonly canDisableReasoning: boolean;
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

/**
 * Fit a requested selection to what a resolved control accepts.
 *
 * An effort the model does not list becomes the nearest weaker listed effort,
 * or the weakest one when nothing below it is listed, so clamping never raises
 * cost past what was asked. A disable request on a model that cannot stop
 * reasoning becomes its weakest effort. Unknown and unsupported controls return
 * the selection untouched: there is no ladder to fit it to.
 */
export function clampReasoningSelection(
  selection: ReasoningSelection | undefined,
  control: ReasoningControlSurface | { readonly kind: "unknown" } | undefined,
): ReasoningSelection | undefined {
  if (!selection || !control || control.kind === "unknown" || control.kind === "unsupported") {
    return selection;
  }
  const listed = "efforts" in control ? control.efforts : undefined;
  const supported: readonly CapabilityReasoningEffort[] =
    listed !== undefined && listed.length > 0
      ? CAPABILITY_REASONING_EFFORTS.filter((effort) => listed.includes(effort))
      : CAPABILITY_REASONING_EFFORTS;
  const weakest = supported[0] ?? "minimal";
  if (selection === "disable") {
    return control.canDisableReasoning ? "disable" : weakest;
  }
  if (supported.includes(selection)) {
    return selection;
  }
  const requestedRank = CAPABILITY_REASONING_EFFORTS.indexOf(selection);
  const weaker = supported.filter(
    (effort) => CAPABILITY_REASONING_EFFORTS.indexOf(effort) < requestedRank,
  );
  return weaker.at(-1) ?? weakest;
}

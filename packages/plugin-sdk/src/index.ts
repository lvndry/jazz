/**
 * Public, types-only ABI for trusted Jazz plugins.
 *
 * Plugins import this module with `import type`; all runtime capabilities are
 * passed to {@link JazzPluginModule.register}. The ABI deliberately uses only
 * JavaScript values, promises, and AbortSignal so host and plugin never need to
 * share Jazz internals, Effect, or another package instance.
 */

export const PLUGIN_API_VERSION = 1 as const;
export const MAX_COMMAND_RISK_COMMAND_CHARS = 4_000;
export const MAX_POLICY_ABSTENTION_REASON_CHARS = 512;
export type JazzPluginApiVersion = typeof PLUGIN_API_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SkillRouteInput {
  readonly requestText: string;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export interface SkillRouteDistribution {
  readonly skills: readonly { readonly name: string; readonly probability: number }[];
  readonly noSkillProbability: number;
}

export type SkillRouteOutcome =
  | { readonly status: "answered"; readonly distribution: SkillRouteDistribution }
  | { readonly status: "abstained"; readonly reason: string };

export interface CommandRiskInput {
  readonly command: string;
}

export interface CommandRiskDistribution {
  readonly readOnlyProbability: number;
  readonly lowRiskProbability: number;
  readonly highRiskProbability: number;
}

export type CommandRiskOutcome =
  | { readonly status: "answered"; readonly distribution: CommandRiskDistribution }
  | { readonly status: "abstained"; readonly reason: string };

export interface CompactToolCandidate {
  /** The tool call's id (`tool_call_id`), used to pair the decision back to the message. */
  readonly id: string;
  readonly tool: string;
  /** Serialized call arguments, bounded by the host. */
  readonly input?: string;
  /** Head+tail preview of the result, so the provider judges content it can actually see. */
  readonly resultPreview: string;
  readonly resultChars: number;
  readonly isError: boolean;
}

export interface CompactToolsInput {
  /** The run's current goal or task, for judging what is still relevant. */
  readonly goal: string;
  readonly candidates: readonly CompactToolCandidate[];
}

export type CompactToolAction = "keep" | "truncate" | "drop";

export interface CompactToolsDecision {
  readonly id: string;
  readonly action: CompactToolAction;
}

export type CompactToolsOutcome =
  | { readonly status: "answered"; readonly decisions: readonly CompactToolsDecision[] }
  | { readonly status: "abstained"; readonly reason: string };

export interface AdvisoryHookContracts {
  readonly "route.skills": { readonly input: SkillRouteInput; readonly output: SkillRouteOutcome };
  readonly "compact.tools": {
    readonly input: CompactToolsInput;
    readonly output: CompactToolsOutcome;
  };
}

export interface PolicyHookContracts {
  readonly "classify.command-risk": {
    readonly input: CommandRiskInput;
    readonly output: CommandRiskOutcome;
  };
}

export type AdvisoryHookId = keyof AdvisoryHookContracts;
export type AdvisoryHookHandler<K extends AdvisoryHookId> = (
  input: AdvisoryHookContracts[K]["input"],
  context: { readonly signal: AbortSignal },
) => Promise<AdvisoryHookContracts[K]["output"]>;

export type PolicyHookId = keyof PolicyHookContracts;
export type PolicyHookHandler<K extends PolicyHookId> = (
  input: PolicyHookContracts[K]["input"],
  context: { readonly signal: AbortSignal },
) => Promise<PolicyHookContracts[K]["output"]>;

export type DecisionQuestion =
  | { readonly kind: "probability"; readonly instructions: string }
  | {
      readonly kind: "choice";
      readonly instructions: string;
      readonly options: readonly { readonly value: string; readonly criterion?: string }[];
    }
  | {
      readonly kind: "score";
      readonly instructions: string;
      readonly levels: readonly [string, string, ...string[]];
    };

export interface DecisionRequest {
  readonly state: JsonValue;
  readonly questions: readonly { readonly id: string; readonly question: DecisionQuestion }[];
}

export type DecisionAnswer =
  | { readonly kind: "probability"; readonly probability: number }
  | {
      readonly kind: "choice";
      readonly choice: string;
      readonly probabilities: readonly { readonly value: string; readonly probability: number }[];
    }
  | { readonly kind: "score"; readonly score: number };

export type DecisionOutcome =
  | { readonly status: "answered"; readonly answer: DecisionAnswer }
  | { readonly status: "abstained"; readonly reason: string };

export interface DecisionBatchResult {
  readonly providerId: string;
  /** Exact version reported by the provider, never a moving alias. */
  readonly model: string;
  readonly answers: readonly { readonly id: string; readonly outcome: DecisionOutcome }[];
  readonly latencyMs: number;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly costUSD?: number;
}

export interface DecisionProvider {
  readonly id: string;
  readonly maxCostUSDPerBatch?: number;
  readonly networkBacked?: boolean;
  decide(
    request: DecisionRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<DecisionBatchResult>;
}

export interface PluginDecisionClient {
  decide(
    request: DecisionRequest,
    context?: { readonly signal?: AbortSignal },
  ): Promise<DecisionBatchResult>;
}

/** Risk tiers a plugin may declare for a tool; mirrors the host's non-`unknown` tiers. */
export type PluginToolRiskLevel = "read-only" | "low-risk" | "high-risk";

/** A model-callable tool declared in the manifest (the reviewed, consented contract). */
export interface PluginToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments, advertised to the model. */
  readonly parameters: JsonValue;
  readonly riskLevel: PluginToolRiskLevel;
  readonly egress: boolean;
}

/** What a plugin tool returns to the host, which relays it to the model as the tool result. */
export interface PluginToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** Trusted host context for a tool invocation; cwd follows the agent's current directory. */
export interface PluginToolContext {
  readonly signal: AbortSignal;
  readonly cwd: string;
}

/** An immutable proposal persisted with Jazz's approval, including parked approvals. */
export interface PluginToolPreparation {
  readonly message: string;
  readonly previewDiff?: string;
  readonly prepared: JsonValue;
}

/** The runtime handler for a tool the manifest declares; the name must match a declaration. */
export interface PluginToolRegistration {
  readonly name: string;
  readonly handler: (
    args: Record<string, unknown>,
    context: PluginToolContext,
  ) => Promise<PluginToolResult>;
  /** Build the exact proposal before approval; only valid for mutating tools. */
  readonly prepare?: (
    args: Record<string, unknown>,
    context: PluginToolContext,
  ) => Promise<PluginToolPreparation>;
  /** Revalidate and apply the prepared proposal after Jazz approves it. */
  readonly executePrepared?: (
    args: Record<string, unknown>,
    prepared: JsonValue,
    context: PluginToolContext,
  ) => Promise<PluginToolResult>;
}

/** A user-invoked slash command declared in the manifest. */
export interface PluginCommandDeclaration {
  readonly name: string;
  readonly description: string;
}

/** What a plugin command returns: a message sent to the agent as the user's turn (empty = no-op). */
export interface PluginCommandResult {
  readonly message?: string;
}

/** A persona a plugin contributes, declared entirely in the manifest (pure, inert configuration). */
export interface PluginPersonaDeclaration {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tone?: string;
  readonly style?: string;
}

/** A skill a plugin contributes, declared entirely in the manifest (inert instructions). */
export interface PluginSkillDeclaration {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

/** The runtime handler for a slash command the manifest declares. */
export interface PluginCommandRegistration {
  readonly name: string;
  readonly handler: (
    input: { readonly args: readonly string[] },
    context: { readonly signal: AbortSignal },
  ) => Promise<PluginCommandResult>;
}

/** Host-emitted lifecycle events a plugin may observe (notifications only, cannot change behavior). */
export type LifecycleEventId =
  | "session-start"
  | "session-end"
  | "user-prompt"
  | "run-complete"
  | "run-failed"
  | "awaiting-input"
  | "tool-start"
  | "tool-end"
  | "tool-error"
  | "subagent-start"
  | "subagent-stop"
  | "compact-start"
  | "compact-end"
  | "permission-request"
  | "permission-denied";

/** The payload delivered to a lifecycle handler. */
export interface LifecycleEvent {
  readonly event: LifecycleEventId;
  readonly agentId: string;
  readonly conversationId: string;
  readonly cwd: string;
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/** A fire-and-forget handler the host calls when a declared lifecycle event occurs. */
/** What a lifecycle handler receives besides the event. */
export interface LifecycleHandlerContext {
  readonly signal: AbortSignal;
  /**
   * Write raw bytes to the user's controlling terminal. Use this for terminal escape sequences (for
   * example an OSC notification): the host targets the controlling terminal directly, so the write
   * reaches it even when a fullscreen TUI owns stdout. Best-effort and never throws.
   */
  readonly writeTerminalSequence: (data: string) => void;
}

export interface PluginLifecycleRegistration {
  readonly event: LifecycleEventId;
  readonly handler: (event: LifecycleEvent, context: LifecycleHandlerContext) => Promise<void>;
}

export interface PluginHostApi {
  readonly apiVersion: JazzPluginApiVersion;
  readonly hooks: {
    register<K extends AdvisoryHookId>(id: K, handler: AdvisoryHookHandler<K>): void;
  };
  readonly policy: {
    register<K extends PolicyHookId>(id: K, handler: PolicyHookHandler<K>): void;
  };
  readonly decisions: {
    registerProvider(provider: DecisionProvider): PluginDecisionClient;
  };
  readonly tools: {
    /** Supplies the handler for a tool the manifest declares; rejected otherwise. */
    register(registration: PluginToolRegistration): void;
  };
  readonly commands: {
    /** Supplies the handler for a slash command the manifest declares; rejected otherwise. */
    register(registration: PluginCommandRegistration): void;
  };
  readonly lifecycle: {
    /** Subscribes a handler to a lifecycle event the manifest declares; rejected otherwise. */
    register(registration: PluginLifecycleRegistration): void;
  };
  readonly secrets: {
    /** Only names declared in the current plugin manifest are resolvable. */
    get(name: string): Promise<string | undefined>;
  };
}

export interface JazzPluginModule {
  readonly apiVersion: JazzPluginApiVersion;
  /** Registration is synchronous; the host seals registries when this returns. */
  register(api: PluginHostApi): void;
  dispose?(): void | Promise<void>;
}

export interface PluginSecretDeclaration {
  readonly name: string;
  readonly env?: string;
  readonly required: boolean;
  readonly description: string;
}

/** Author-maintained metadata before pack adds `artifact` and `sha256`. */
export interface JazzPluginSourceManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: JazzPluginApiVersion;
  readonly entry?: string;
  readonly hooks: readonly AdvisoryHookId[];
  readonly policyHooks: readonly PolicyHookId[];
  readonly decisionProviders: readonly string[];
  readonly tools?: readonly PluginToolDeclaration[];
  readonly commands?: readonly PluginCommandDeclaration[];
  readonly personas?: readonly PluginPersonaDeclaration[];
  readonly skills?: readonly PluginSkillDeclaration[];
  readonly lifecycleHooks?: readonly LifecycleEventId[];
  readonly network: { readonly destinations: readonly string[] };
  readonly dataSent: readonly string[];
  readonly secrets: readonly PluginSecretDeclaration[];
}

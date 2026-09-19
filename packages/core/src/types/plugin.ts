/**
 * Public, dependency-free ABI shared by Jazz and trusted in-process plugins.
 * Values crossing this boundary are JSON-compatible; cancellation is cooperative.
 */

import { Data } from "effect";

export const PLUGIN_API_VERSION = 1 as const;
export const MAX_PLUGIN_STATE_BYTES = 64 * 1024;
export const MAX_DECISION_QUESTIONS = 64;
export const MAX_DECISION_OPTIONS = 255;
export const MAX_PLUGIN_IDENTIFIER_LENGTH = 128;
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 2_000;

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

export interface AdvisoryHookContracts {
  readonly "route.skills": { readonly input: SkillRouteInput; readonly output: SkillRouteOutcome };
}

export type AdvisoryHookId = keyof AdvisoryHookContracts;
export type AdvisoryHookHandler<K extends AdvisoryHookId> = (
  input: AdvisoryHookContracts[K]["input"],
  context: { readonly signal: AbortSignal },
) => Promise<AdvisoryHookContracts[K]["output"]>;

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
  readonly model: string;
  readonly answers: readonly { readonly id: string; readonly outcome: DecisionOutcome }[];
  readonly latencyMs: number;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly costUSD?: number;
}

export interface DecisionProvider {
  readonly id: string;
  /** Required for a provider that can spend money, so the host can reserve budget before calling. */
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

export interface PluginSecretDeclaration {
  readonly name: string;
  readonly env?: string;
  readonly required: boolean;
  readonly description: string;
}

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: typeof PLUGIN_API_VERSION;
  readonly artifact: string;
  readonly sha256: string;
  readonly hooks: readonly AdvisoryHookId[];
  readonly decisionProviders: readonly string[];
  readonly network: { readonly destinations: readonly string[] };
  readonly dataSent: readonly string[];
  readonly secrets: readonly PluginSecretDeclaration[];
}

export interface PluginConsentDisclosure {
  readonly pluginId: string;
  readonly codeDigest: string;
  readonly hooks: readonly AdvisoryHookId[];
  readonly decisionProviders: readonly string[];
  readonly destinations: readonly string[];
  readonly dataSent: readonly string[];
}

export interface PluginConsentGrant {
  readonly digest: string;
  readonly grantedAt: string;
}

export interface PluginHostApi {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly hooks: {
    register<K extends AdvisoryHookId>(id: K, handler: AdvisoryHookHandler<K>): void;
  };
  readonly decisions: {
    /** Registers a backend and returns the only client plugins may use to invoke it. */
    registerProvider(provider: DecisionProvider): PluginDecisionClient;
  };
  readonly secrets: {
    /** Only names declared by the current plugin manifest are resolvable. */
    get(name: string): Promise<string | undefined>;
  };
}

export interface JazzPluginModule {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  /** Registration is synchronous so the host can seal capabilities before execution begins. */
  register(api: PluginHostApi): void;
  dispose?(): void | Promise<void>;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly module: JazzPluginModule;
}

export class PluginValidationError extends Data.TaggedError("PluginValidationError")<{
  readonly message: string;
}> {}

export class PluginRuntimeError extends Data.TaggedError("PluginRuntimeError")<{
  readonly pluginId?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PluginRegistryError extends Data.TaggedError("PluginRegistryError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

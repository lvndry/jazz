/**
 * The one path to TypeSafe's System One API, through the AI SDK's TypeSafe provider. Every Jev call
 * in this plugin (host hooks and the chat-facing decide tool) goes through `decideWithJev`, so the
 * pinned model, the declared network destination, and cost accounting live in one place.
 */

import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import {
  experimental_decide,
  type Experimental_DecisionAnswer,
  type Experimental_DecisionQuestion,
  type Experimental_DecisionState,
} from "ai";

/**
 * Passed explicitly so a `TYPESAFE_AI_BASE_URL` in the environment can never redirect requests to a
 * host the plugin manifest does not declare.
 */
export const JEV_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_MODEL = "jev-1.14.0";

/** TypeSafe list price for Jev input tokens; output tokens are not billed. */
export const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.042;
/** TypeSafe's per-request input limit without the long-context option. */
export const JEV_MAX_INPUT_TOKENS = 64_000;
/** TypeSafe's limit on options in one choice question. */
export const JEV_MAX_CHOICE_OPTIONS = 255;
/** TypeSafe's limit on ordered levels in one score question. */
export const JEV_MAX_SCORE_LEVELS = 10;

export type JevQuestion = Experimental_DecisionQuestion;
export type JevAnswer = Experimental_DecisionAnswer<JevQuestion>;

export interface JevDecision {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  /** Jev's confidence per choice/score question, when it reports one. */
  readonly confidence: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUSD: number;
}

export interface JevRequest {
  readonly apiKey: string;
  readonly state: Experimental_DecisionState;
  readonly questions: Readonly<Record<string, JevQuestion>>;
  readonly signal: AbortSignal;
  /** Retries for overloaded or failed responses; the AI SDK waits 2s before the first one. */
  readonly maxRetries: number;
}

function readConfidence(providerMetadata: unknown): Record<string, number> {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return {};
  }
  const typesafe = (providerMetadata as Record<string, unknown>)["typesafe"];
  if (typeof typesafe !== "object" || typesafe === null) {
    return {};
  }
  const confidence = (typesafe as Record<string, unknown>)["confidence"];
  if (typeof confidence !== "object" || confidence === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(confidence).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

/**
 * Ask Jev every question against one shared state. The AI SDK validates each answer's distribution
 * and retries overloaded responses; this rejects any model other than the pinned one, because every
 * threshold in this plugin was tuned against that version.
 */
export async function decideWithJev(request: JevRequest): Promise<JevDecision> {
  const model = createTypeSafeAi({ apiKey: request.apiKey, baseURL: JEV_BASE_URL }).decisionModel(
    JEV_MODEL,
  );
  const result = await experimental_decide({
    model,
    state: request.state,
    questions: request.questions,
    abortSignal: request.signal,
    maxRetries: request.maxRetries,
  });
  if (result.response.modelId !== JEV_MODEL) {
    throw new Error(`TypeSafe returned unevaluated model version ${result.response.modelId}`);
  }
  const inputTokens = result.usage.inputTokens;
  const outputTokens = result.usage.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new Error("TypeSafe did not report token usage");
  }
  return {
    model: result.response.modelId,
    answers: result.answers,
    confidence: readConfidence(result.providerMetadata),
    inputTokens,
    outputTokens,
    costUSD: (inputTokens * JEV_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
  };
}

/**
 * Optional trusted Jazz plugin that routes skill requests through TypeSafe's
 * System One API. It uses only the public plugin ABI, pins the model version
 * used for evaluation, and fails open through explicit abstention.
 */

import type {
  DecisionAnswer,
  DecisionBatchResult,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  JazzPluginModule,
  JsonValue,
  PluginDecisionClient,
  PluginHostApi,
  SkillRouteInput,
  SkillRouteOutcome,
} from "@jazz/plugin-sdk";

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const JEV_PROVIDER_ID = "typesafe-jev";

const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.042;
const JEV_MAX_INPUT_TOKENS = 64_000;
const MAX_COST_USD_PER_BATCH =
  (JEV_MAX_INPUT_TOKENS * JEV_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000;
const MAX_CHOICE_OPTIONS = 255;
const MAX_ROUTING_STATE_BYTES = 64 * 1024;
const MAX_RETRIES = 2;

type JevQuestion =
  | { readonly type: "noul"; readonly instructions: string }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      readonly criteria: readonly string[];
    };

interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseDistribution(
  value: unknown,
  expectedKeys: readonly string[],
): readonly { readonly value: string; readonly probability: number }[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== expectedKeys.length) return undefined;
  let sum = 0;
  const parsed: { value: string; probability: number }[] = [];
  for (const key of expectedKeys) {
    const probability = value[key];
    if (!finiteUnit(probability)) return undefined;
    parsed.push({ value: key, probability });
    sum += probability;
  }
  return Math.abs(sum - 1) <= 0.001 ? parsed : undefined;
}

function mapQuestion(question: DecisionQuestion): JevQuestion {
  switch (question.kind) {
    case "probability":
      return { type: "noul", instructions: question.instructions };
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map(({ value, criterion }) => [value, criterion ?? null]),
        ),
      };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: question.levels };
  }
}

function parseAnswer(question: DecisionQuestion, value: unknown): DecisionAnswer | undefined {
  if (!isRecord(value)) return undefined;
  switch (question.kind) {
    case "probability":
      return value["type"] === "noul" && finiteUnit(value["noul"])
        ? { kind: "probability", probability: value["noul"] }
        : undefined;
    case "choice": {
      if (
        value["type"] !== "choice" ||
        typeof value["choice"] !== "string" ||
        !finiteUnit(value["confidence"])
      ) {
        return undefined;
      }
      const keys = question.options.map(({ value: option }) => option);
      const probabilities = parseDistribution(value["probabilities"], keys);
      if (probabilities === undefined) return undefined;
      const choice = value["choice"];
      const selected = probabilities.find(({ value: option }) => option === choice);
      const maximum = Math.max(...probabilities.map(({ probability }) => probability));
      return selected !== undefined && Math.abs(selected.probability - maximum) <= 0.001
        ? { kind: "choice", choice, probabilities }
        : undefined;
    }
    case "score": {
      if (
        value["type"] !== "score" ||
        typeof value["score"] !== "number" ||
        !Number.isFinite(value["score"]) ||
        !finiteUnit(value["confidence"]) ||
        !isRecord(value["legend"])
      ) {
        return undefined;
      }
      const keys = question.levels.map((_level, index) => String(index));
      const probabilities = parseDistribution(value["probabilities"], keys);
      if (probabilities === undefined) return undefined;
      for (const [index, level] of question.levels.entries()) {
        if (value["legend"][String(index)] !== level) return undefined;
      }
      const computed = probabilities.reduce(
        (sum, item, index) => sum + index * item.probability,
        0,
      );
      return Math.abs(computed - value["score"]) <= 0.001
        ? { kind: "score", score: value["score"] }
        : undefined;
    }
  }
}

function parseRetryAfter(value: string | null): number {
  if (value === null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 5_000)) : 0;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Jev request aborted");
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function postJev(apiKey: string, body: JsonValue, signal: AbortSignal): Promise<JevResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(JEV_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return (await response.json()) as JevResponse;
    if ((response.status !== 429 && response.status !== 529) || attempt >= MAX_RETRIES) {
      throw new Error(`TypeSafe request failed with HTTP ${response.status}`);
    }
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    await abortableDelay(retryAfter || 100 * 2 ** attempt, signal);
  }
}

/** Create a TypeSafe provider bound to Jazz's scoped secret broker. */
export function createJevDecisionProvider(api: PluginHostApi): DecisionProvider {
  return {
    id: JEV_PROVIDER_ID,
    networkBacked: true,
    maxCostUSDPerBatch: MAX_COST_USD_PER_BATCH,
    async decide(request, context): Promise<DecisionBatchResult> {
      const apiKey = await api.secrets.get("apiKey");
      if (apiKey === undefined || apiKey.length === 0)
        throw new Error("TypeSafe API key is missing");
      const mappedQuestions = Object.fromEntries(
        request.questions.map(({ id, question }) => [id, mapQuestion(question)]),
      );
      const startedAt = performance.now();
      const response = await postJev(
        apiKey,
        { state: request.state, model: JEV_MODEL, questions: mappedQuestions },
        context.signal,
      );
      if (response.model !== JEV_MODEL) {
        throw new Error(`TypeSafe returned unevaluated model version ${response.model}`);
      }
      if (!isRecord(response.answers) || !isRecord(response.usage)) {
        throw new Error("TypeSafe returned a malformed response");
      }
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
        throw new Error("Invalid token usage");
      if (!Number.isSafeInteger(outputTokens) || outputTokens < 0)
        throw new Error("Invalid token usage");
      return {
        providerId: JEV_PROVIDER_ID,
        model: response.model,
        latencyMs: performance.now() - startedAt,
        answers: request.questions.map(({ id, question }) => {
          const answer = parseAnswer(question, response.answers[id]);
          return {
            id,
            outcome:
              answer === undefined
                ? { status: "abstained" as const, reason: "invalid provider answer" }
                : { status: "answered" as const, answer },
          };
        }),
        usage: { inputTokens, outputTokens },
        costUSD: (inputTokens * JEV_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
      };
    },
  };
}

function routingRequest(input: SkillRouteInput): DecisionRequest | undefined {
  if (input.skills.length === 0 || input.skills.length + 1 > MAX_CHOICE_OPTIONS) return undefined;
  const state = {
    request: input.requestText,
    skills: input.skills.map((skill) => ({ name: skill.name, description: skill.description })),
  } satisfies JsonValue;
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_ROUTING_STATE_BYTES) {
    return undefined;
  }
  return {
    state,
    questions: [
      {
        id: "best_skill",
        question: {
          kind: "choice",
          instructions:
            "Choose the one installed skill that would most materially help answer the current request, or no_skill.",
          options: [
            {
              value: "no_skill",
              criterion: "No installed skill would materially improve this request.",
            },
            ...input.skills.map((skill, index) => ({
              value: `skill_${index}`,
              criterion: `${skill.name}: ${skill.description}`,
            })),
          ],
        },
      },
    ],
  };
}

async function routeSkills(
  client: PluginDecisionClient,
  input: SkillRouteInput,
  signal: AbortSignal,
): Promise<SkillRouteOutcome> {
  const request = routingRequest(input);
  if (request === undefined) return { status: "abstained", reason: "routing input exceeds limits" };
  const result = await client.decide(request, { signal });
  const outcome = result.answers.find(({ id }) => id === "best_skill")?.outcome;
  if (outcome?.status !== "answered" || outcome.answer.kind !== "choice") {
    return {
      status: "abstained",
      reason: outcome?.status === "abstained" ? outcome.reason : "Jev did not answer skill routing",
    };
  }
  const byOption = new Map(
    outcome.answer.probabilities.map(({ value, probability }) => [value, probability] as const),
  );
  const noSkillProbability = byOption.get("no_skill");
  if (noSkillProbability === undefined) {
    return { status: "abstained", reason: "Jev omitted the no-skill probability" };
  }
  return {
    status: "answered",
    distribution: {
      noSkillProbability,
      skills: input.skills.map((skill, index) => ({
        name: skill.name,
        probability: byOption.get(`skill_${index}`) ?? 0,
      })),
    },
  };
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    const client = api.decisions.registerProvider(createJevDecisionProvider(api));
    api.hooks.register("route.skills", (input, context) =>
      routeSkills(client, input, context.signal),
    );
  },
};

export default plugin;

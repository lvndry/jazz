/**
 * Compare reasoning settings on one frozen production summarizer request.
 *
 * Run with a private JAZZ_HOME containing the agent and provider configuration:
 * bun evals/compaction-reasoning.ts --agent <id> --history <conversation.jsonl>
 *   --before <ISO timestamp> --samples 2 --output <private report.json>
 *
 * History is read only. The production history reducer, saved compaction boundary, prompt builder and
 * provider adapter construct the request; capture performs no inference. Each measured
 * call reuses that request, varying only reasoning. Pair order alternates to expose
 * cache/order effects. Reports include summaries for human fidelity review, but never
 * include provider credentials or reasoning text. --capture-only skips measured calls.
 * Only single-request production captures are replayed. Non-loopback endpoints require
 * --allow-remote, including named hosts; prefer a loopback IP for same-machine inference.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseConversationLog,
  reduceConversationLog,
} from "@jazz/adapters/history/conversation-log";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { PINNED_KINDS } from "@jazz/core/agent/context/context-window-manager";
import { Summarizer, type RecursiveRunner } from "@jazz/core/agent/context/summarizer";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import type { ChatCompletionOptions, ChatCompletionResponse } from "@jazz/core/types/chat";
import { withAgentProviderOverrides } from "@jazz/core/utils/agent-llm-config";
import { Duration, Effect } from "effect";
import { createAppLayer } from "../packages/runtime/src/app-layer";
import { readOption } from "./cli-options";
import { assertVllmReplayProviders, validateVllmReplayEndpoint } from "./compaction-replay-safety";
import { saveReport } from "./compaction-report";

interface Measurement {
  readonly sample: number;
  readonly reasoning: "medium" | "disable";
  readonly durationMs: number;
  readonly usage: ChatCompletionResponse["usage"];
  readonly finishReason: ChatCompletionResponse["finishReason"];
  readonly summary: string;
}

const historyPath = readOption("--history", "");
const agentId = readOption("--agent", "");
const before = readOption("--before", "");
const output = readOption("--output", "");
const samples = Number(readOption("--samples", "2"));
if (!process.env["JAZZ_HOME"] || !historyPath || !agentId || !before || !output) {
  throw new Error("A private JAZZ_HOME, --agent, --history, --before and --output are required");
}
if (!Number.isFinite(Date.parse(before)) || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("Invalid --before or --samples");
}
const allEvents = parseConversationLog(readFileSync(historyPath, "utf8"));
const events = allEvents.filter(
  (event) => !("at" in event) || Date.parse(event.at) < Date.parse(before),
);
const conversation = reduceConversationLog(events);
if (!conversation || conversation.messages.length === 0) {
  throw new Error("No conversation at the requested cutoff");
}
const history = conversation.messages;
const checkpointIndex = allEvents.findIndex(
  (event) => event.type === "context" && Date.parse(event.at) >= Date.parse(before),
);
const compacted = reduceConversationLog(allEvents.slice(0, checkpointIndex + 1));
if (checkpointIndex < 0 || !compacted) {
  throw new Error("No saved compaction follows the requested cutoff");
}
const retainedIds = new Set(compacted.messages.map((message) => message.entryId));
const tailIndex = history.findIndex(
  (message) =>
    retainedIds.has(message.entryId) &&
    message.role !== "system" &&
    message.kind !== "summary" &&
    message.kind !== "continuation" &&
    !(message.kind !== undefined && PINNED_KINDS.has(message.kind)),
);
if (tailIndex < 1) {
  throw new Error("Cannot identify the saved compaction's retained tail");
}
const priorSummary = history.find((message) => message.kind === "summary");
const messagesToSummarize = history
  .slice(0, tailIndex)
  .filter(
    (message) =>
      message.role !== "system" &&
      message.kind !== "summary" &&
      message.kind !== "continuation" &&
      !(message.kind !== undefined && PINNED_KINDS.has(message.kind)),
  );
const measurements: Measurement[] = [];

const experiment = Effect.gen(function* () {
  const agent = yield* (yield* AgentServiceTag).getAgent(agentId);
  assertVllmReplayProviders(agent);
  const llm = yield* LLMServiceTag;
  const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
  const baseUrl = llm.resolveLocalProviderBaseUrl(
    "vllm",
    withAgentProviderOverrides(appConfig.llm, agent.config.llm),
  );
  const endpoint = validateVllmReplayEndpoint(baseUrl, {
    allowRemote: process.argv.includes("--allow-remote"),
  });
  console.log(
    JSON.stringify({
      phase: "destination",
      origin: endpoint.origin,
      isLoopback: endpoint.isLoopback,
      transmission: process.argv.includes("--capture-only")
        ? "metadata-only"
        : "conversation-history",
    }),
  );
  const requests: ChatCompletionOptions[] = [];
  const capturingLLM: LLMService = {
    getProvider: llm.getProvider.bind(llm),
    listProviders: llm.listProviders.bind(llm),
    supportsNativeWebSearch: llm.supportsNativeWebSearch.bind(llm),
    resolveReasoningControl: llm.resolveReasoningControl.bind(llm),
    fetchOllamaModelDetails: llm.fetchOllamaModelDetails.bind(llm),
    fetchLlamaCppServerModel: llm.fetchLlamaCppServerModel.bind(llm),
    fetchVllmServerModel: (baseUrl, model, apiKey) =>
      llm.fetchVllmServerModel(baseUrl, model, apiKey ?? agent.config.llm.apiKeys?.vllm),
    fetchSglangServerModel: llm.fetchSglangServerModel.bind(llm),
    resolveLocalProviderBaseUrl: llm.resolveLocalProviderBaseUrl.bind(llm),
    createChatCompletion: (provider, request) =>
      Effect.sync(() => {
        if (provider !== "vllm") {
          throw new Error("Production selected a non-vLLM completion provider");
        }
        requests.push(request);
        return { id: "capture", model: request.model, content: "captured", finishReason: "stop" };
      }),
    createStreamingChatCompletion: () => Effect.die(new Error("Unexpected streaming capture")),
  };
  const runner: RecursiveRunner = (options) =>
    AgentRunner.runRecursive({
      ...options,
      agent: {
        ...options.agent,
        config: {
          ...options.agent.config,
          llm: { ...options.agent.config.llm, reasoning: "medium" },
        },
      },
      disablePersistence: true,
    }).pipe(Effect.provideService(LLMServiceTag, capturingLLM));
  yield* Summarizer.summarizeHistory(
    messagesToSummarize,
    agent,
    conversation.conversationId,
    runner,
    priorSummary,
  ).pipe(Effect.provideService(LLMServiceTag, capturingLLM));
  const captured = requests[0];
  console.log(
    JSON.stringify({
      phase: "capture-metadata",
      historyMessages: history.length,
      summarizedMessages: messagesToSummarize.length,
      requests: requests.map((entry) => ({
        model: entry.model,
        roles: entry.messages.map((message) => message.role),
        chars: entry.messages.map((message) => message.content?.length ?? 0),
      })),
    }),
  );
  if (requests.length !== 1 || !captured) {
    throw new Error(
      `Production requires ${requests.length} summarizer requests; only single-request captures can be compared`,
    );
  }
  const request = {
    ...captured,
    providerBaseUrls: { ...captured.providerBaseUrls, vllm: baseUrl },
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        toolChoice: request.toolChoice,
      }),
    )
    .digest("hex");
  const save = (): void =>
    saveReport(output, {
      requestFingerprint: fingerprint,
      historyMessages: history.length,
      summarizedMessages: messagesToSummarize.length,
      provider: agent.config.llm.provider,
      endpointOrigin: endpoint.origin,
      model: request.model,
      before,
      measurements,
    });
  save();
  console.log(
    JSON.stringify({
      phase: "captured",
      historyMessages: history.length,
      summarizedMessages: messagesToSummarize.length,
      fingerprint,
    }),
  );
  if (process.argv.includes("--capture-only")) {
    return;
  }
  for (let sample = 0; sample < samples; sample++) {
    const order: readonly ("medium" | "disable")[] =
      sample % 2 === 0 ? ["medium", "disable"] : ["disable", "medium"];
    for (const reasoning of order) {
      console.log(JSON.stringify({ phase: "started", sample, reasoning }));
      const started = performance.now();
      const response = yield* llm
        .createChatCompletion("vllm", { ...request, reasoning })
        .pipe(Effect.timeout(Duration.minutes(10)));
      measurements.push({
        sample,
        reasoning,
        durationMs: performance.now() - started,
        usage: response.usage,
        finishReason: response.finishReason,
        summary: response.content,
      });
      save();
      console.log(
        JSON.stringify({
          phase: "completed",
          sample,
          reasoning,
          durationMs: measurements.at(-1)?.durationMs,
          usage: response.usage,
          finishReason: response.finishReason,
          summaryChars: response.content.length,
        }),
      );
      if (
        !response.content.trim() ||
        response.finishReason !== "stop" ||
        response.toolCalls?.length
      ) {
        throw new Error("Unusable summary; saved partial report for inspection");
      }
    }
  }
});

await Effect.runPromise(experiment.pipe(Effect.provide(createAppLayer())));

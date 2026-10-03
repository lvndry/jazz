import {
  loadConversation,
  saveConversation,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";
import { drainNotifyOutbox } from "@jazz/adapters/notification/outbox-drain";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { buildWorkStatePreamble } from "@jazz/core/agent/context/work-state-preamble";
import { judgeAnswer } from "@jazz/core/agent/run/answer-outcome";
import { RunParkRequested, isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { isRunCostKnown, runSpendAsCallSpend } from "@jazz/core/agent/run/run-spend";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
import { CommonSuggestions, getErrorMessage } from "@jazz/core/presentation/error-handler";
import {
  detectInteractiveInput,
  makeOneShotPresentationServiceLayer,
} from "@jazz/core/presentation/oneshot-presentation-service";
import { AgentNotFoundError } from "@jazz/core/types/errors";
import type { CompanionRole } from "@jazz/core/types/llm";
import type { ChatMessage } from "@jazz/core/types/message";
import type { JsonValue, LifecycleEventId } from "@jazz/core/types/plugin";
import type { StreamEvent } from "@jazz/core/types/streaming";
import type { ApprovalPolicyLevel, AutoApprovePolicy } from "@jazz/core/types/tools";
import type { StoppedToolCall } from "@jazz/core/types/tools";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { createRunDeadline } from "@jazz/core/utils/run-deadline";
import { Effect, Layer, Option } from "effect";
import { describeReasoningAdjustment } from "@/cli/helpers/reasoning";
import {
  ONE_SHOT_EXIT,
  answerOutcomeFields,
  formatOneShotError,
  type OneShotSpend,
  type OneShotFailureDetails,
  formatOneShotParked,
  formatOneShotResult,
  type OneShotOutputOptions,
  type OneShotComposition,
} from "./envelope";
import type { ReasoningEffort } from "./flags";
import { parseStdinRunInput, readFirstStdinLine } from "./stdin-input";

/**
 * One-shot, non-interactive agent invocation — designed to be driven from
 * scripts and webhook handlers (Slack, Google Chat, etc.).
 *
 * Unlike `jazz agent chat` (an interactive REPL) and `jazz workflow run` (a
 * fixed, file-defined prompt), this command takes a dynamic prompt, runs a
 * single turn, and prints a clean payload to stdout. All operational noise
 * (status notices, tool chatter, the `◉ Agent:` header, the `✔ completed`
 * footer) is routed to stderr so stdout carries only the answer (plain mode)
 * or exactly one JSON object (`--json`).
 *
 * With `--conversation <id>` the run gains memory: prior history stored under
 * the caller-supplied key is loaded before the run and the updated transcript
 * is saved back after, so a webhook bridge that passes its chat id gets
 * per-chat context across invocations without storing anything itself.
 */

/**
 * Narrow `create_composition`'s structured tool result (last call wins if invoked
 * more than once in a turn) out of the agent run's `toolResults` map.
 */
/**
 * Assemble the history a resumed run starts from.
 *
 * Conversation history is saved only when a run *completes*, so a run killed mid-flight
 * leaves `priorRecord === null` while its journal — written during the run, at each
 * compaction — survives. That case must still produce a history, or the journal becomes
 * unreadable in precisely the situation it exists for.
 *
 * Returns `null` only when there is genuinely nothing to resume from.
 */
export function composeResumedHistory(
  priorRecord: Conversation | null,
  workStatePreamble: ChatMessage | undefined,
): ChatMessage[] | null {
  if (priorRecord !== null) {
    return workStatePreamble !== undefined
      ? [workStatePreamble, ...priorRecord.messages]
      : priorRecord.messages;
  }
  return workStatePreamble !== undefined ? [workStatePreamble] : null;
}

export function extractCompositionResult(
  toolResults: Record<string, unknown> | undefined,
): OneShotComposition | undefined {
  const raw = toolResults?.["create_composition"];
  if (!raw || typeof raw !== "object") return undefined;

  const data = raw as Record<string, unknown>;
  if (
    typeof data["id"] !== "string" ||
    (data["mode"] !== "static" && data["mode"] !== "interactive") ||
    typeof data["title"] !== "string" ||
    typeof data["sessionId"] !== "string" ||
    typeof data["filename"] !== "string" ||
    typeof data["htmlPath"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: data["id"],
    mode: data["mode"],
    title: data["title"],
    sessionId: data["sessionId"],
    filename: data["filename"],
    htmlPath: data["htmlPath"],
    ...(typeof data["imagePath"] === "string" ? { imagePath: data["imagePath"] } : {}),
  };
}

export interface RunAgentOnceOptions {
  readonly json: boolean;
  readonly approvalPolicy?: ApprovalPolicyLevel | undefined;
  /** Give the agent `propose_goal`; a proposal waits for `jazz goal accept`. */
  readonly proposeGoals?: boolean;
  /**
   * Tool names to auto-approve without prompting, regardless of `approvalPolicy`.
   * Narrower than raising the whole risk tier — e.g. `["execute_command"]` unblocks
   * shell commands without also auto-approving `rm`/etc.
   */
  readonly autoApprovedTools?: readonly string[] | undefined;
  /**
   * IANA timezone (e.g. "Europe/Paris") used to resolve relative/clock times
   * for this run (e.g. the add_reminder tool). Defaults to UTC when unset.
   */
  readonly timezone?: string | undefined;
  readonly reasoning?: ReasoningEffort | undefined;
  /**
   * Per-run companion bindings overriding the agent's own `config.companions`.
   * A bound companion is what lets an unattended run delegate perception without
   * a human to pick the model.
   */
  readonly companions?: Partial<Record<CompanionRole, `${string}/${string}`>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxIterations?: number | undefined;
  readonly maxSubagentIterations?: number | undefined;
  readonly maxCostUSD?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly eventTypes?: ReadonlySet<StreamEvent["type"]> | undefined;
  /**
   * Force streaming on/off. Streaming auto-disables for non-TTY stdout, which
   * suppresses `--events`; setting this true re-enables it for scripts/webhooks.
   */
  readonly stream?: boolean | undefined;
  /**
   * This caller will relay an `ask_user_question` to a human and write the answer
   * back on stdin (a chat bridge). Only needed where that cannot be detected: a
   * terminal is recognised on its own. Without either, the interactive tools are
   * withheld entirely, so an unattended run cannot stop to ask something nobody
   * will read.
   */
  readonly interactiveStdin?: boolean | undefined;
  /**
   * Caller-supplied stable conversation key (e.g. a Telegram chat id). When
   * set, prior history for this conversation is loaded before the run and the
   * updated transcript is saved back after — giving stateless webhook bridges
   * per-chat memory across invocations. Absent = one-shot (no persistence).
   */
  readonly conversationId?: string | undefined;
  /**
   * Skip persistence entirely for this run: `--conversation` is ignored (no
   * history load/save), and the `manage_memory` tool is withheld (no
   * long-term memory writes). Nothing about this run ever touches disk.
   */
  readonly ephemeral?: boolean | undefined;
  /**
   * Read the prompt, and for an `ephemeral` run its prior messages, from the first stdin line
   * (see `stdin-input.ts`). The caller (a chat bridge) holds an incognito transcript itself and
   * passes it back each turn instead of it living on disk, and neither travels on argv.
   */
  readonly inputStdin?: boolean | undefined;
  /**
   * Park instead of declining when a gated tool needs approval nobody here can give.
   *
   * Off by default because it changes what an unattended run *does*: without it a cron job
   * that hits `git push` refuses and carries on, with it the job stops and waits for a
   * person. Only turn it on where somebody is actually going to answer.
   */
  readonly park?: boolean | undefined;
}

/**
 * Build the conversation record to persist after a `--conversation` run.
 *
 * Prefers the runner's full message transcript (which includes tool calls and
 * the system message — the prompt builder filters system messages back out on
 * the next load). Falls back to appending the user/assistant pair to the prior
 * transcript when the runner returned no messages array.
 */
export function buildConversation(params: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly prompt: string;
  readonly priorRecord: Conversation | null;
  readonly responseContent: string;
  readonly responseMessages: ChatMessage[] | undefined;
  readonly now: string;
}): Conversation {
  const messages: ChatMessage[] =
    params.responseMessages && params.responseMessages.length > 0
      ? params.responseMessages
      : [
          ...(params.priorRecord?.messages ?? []),
          { role: "user", content: params.prompt },
          { role: "assistant", content: params.responseContent },
        ];

  return {
    conversationId: params.conversationId,
    title: params.priorRecord?.title ?? params.prompt.trim().slice(0, 80),
    agentId: params.agentId,
    startedAt: params.priorRecord?.startedAt ?? params.now,
    updatedAt: params.now,
    messages,
  };
}

function readStdin(): Promise<string> {
  // Reads to end of stream, so it cannot share stdin with the approval protocol
  // `OneShotPresentationService` reads. A bridge that needs both uses
  // `--input-stdin`, which consumes only the first line.
  // If stdin already ended, the "end" event has fired and won't fire again —
  // registering a new listener would hang forever.
  if (process.stdin.readableEnded) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

const writeStdout = (message: string): Effect.Effect<void, never> =>
  Effect.sync(() => {
    process.stdout.write(message);
  });

const failOneShot = (
  message: string,
  options: OneShotOutputOptions,
  spend?: OneShotSpend,
  details: OneShotFailureDetails = {},
): Effect.Effect<void, never> =>
  Effect.sync(() => {
    const formatted = formatOneShotError(message, options, spend, details);
    // JSON mode keeps the single-object stdout contract; plain mode sends the
    // human-readable error to stderr so stdout stays empty on failure.
    if (options.json) {
      process.stdout.write(formatted);
    } else {
      process.stderr.write(formatted);
    }
    process.exitCode = ONE_SHOT_EXIT.failed;
  });

/** Inline history comes from the caller, so any memory source in it is forged. */
export function stripMemorySources(history: readonly ChatMessage[]): ChatMessage[] {
  return history.map((message) => {
    const copy = { ...message };
    delete copy.memorySource;
    return copy;
  });
}

/**
 * Run an agent once against a dynamic prompt and print a clean payload.
 *
 * The prompt comes from the positional argument, the `--input-stdin` frame, or, when
 * neither is given, piped stdin. Webhook text is untrusted and stdin avoids shell-escaping
 * it. Only a positional or framed prompt may be quoted as a memory source: both are the
 * caller's own message, while piped stdin is a body relayed from somewhere else.
 */
export function runAgentOnceCommand(
  agentIdentifier: string,
  promptArg: string | undefined,
  options: RunAgentOnceOptions,
) {
  const outputOptions: OneShotOutputOptions = { json: options.json };
  // Resolved once and shared, so the toolset the model is offered and the way a
  // question is delivered can never disagree about whether anyone is reachable.
  const interactiveInput = detectInteractiveInput(options.interactiveStdin === true);
  // Deadline can be pushed out while blocked on a human approval decision (see
  // requestApproval in OneShotPresentationService) so waiting on a person
  // doesn't count against the same budget as the agent's own work.
  const deadline = options.timeoutMs != null ? createRunDeadline(options.timeoutMs) : undefined;
  // Set when the run ends however it ends, so a failure envelope can report what it spent.
  let runSpend: OneShotSpend | undefined;
  // Set when a tool batch is stopped part-way, so a failure envelope can say what ran.
  let stoppedToolCalls: readonly StoppedToolCall[] | undefined;

  return Effect.gen(function* () {
    const normalizedIdentifier = agentIdentifier.trim();
    if (normalizedIdentifier.length === 0) {
      return yield* failOneShot("No agent specified. Use --agent <agentId>.", outputOptions);
    }

    let prompt = promptArg ?? "";
    const promptFromArgument = prompt.trim().length > 0;
    let framedHistory: readonly unknown[] | undefined;
    if (options.inputStdin === true) {
      if (promptFromArgument) {
        return yield* failOneShot(
          "Pass the prompt as an argument or with --input-stdin, not both.",
          outputOptions,
        );
      }
      const frame = parseStdinRunInput(
        yield* Effect.tryPromise({
          try: () => readFirstStdinLine(),
          catch: () => new Error("Failed to read --input-stdin from stdin."),
        }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
      );
      if (!frame.ok) {
        return yield* failOneShot(frame.error, outputOptions);
      }
      if (frame.input.history !== undefined && options.ephemeral !== true) {
        return yield* failOneShot(
          '--input-stdin "history" is only read with --ephemeral; use --conversation to load saved history.',
          outputOptions,
        );
      }
      prompt = frame.input.prompt;
      framedHistory = frame.input.history;
    } else if (!promptFromArgument && !process.stdin.isTTY) {
      prompt = yield* Effect.tryPromise({
        try: () => readStdin(),
        catch: () => new Error("Failed to read prompt from stdin."),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
    }
    if (prompt.trim().length === 0) {
      return yield* failOneShot(
        "No prompt provided. Pass it as an argument or pipe it via stdin.",
        outputOptions,
      );
    }

    const agent = yield* getAgentByIdentifier(normalizedIdentifier).pipe(
      Effect.catchTag("StorageNotFoundError", () =>
        Effect.fail(
          new AgentNotFoundError({
            agentId: normalizedIdentifier,
            suggestion: CommonSuggestions.checkAgentExists(normalizedIdentifier),
          }),
        ),
      ),
    );

    const agentForRun =
      options.reasoning !== undefined || options.companions !== undefined
        ? {
            ...agent,
            config: {
              ...agent.config,
              ...(options.reasoning !== undefined
                ? {
                    llm: { ...agent.config.llm, reasoning: options.reasoning },
                  }
                : {}),
              ...(options.companions !== undefined ? { companions: options.companions } : {}),
            },
          }
        : agent;

    if (options.reasoning !== undefined) {
      const control = yield* (yield* LLMServiceTag).resolveReasoningControl(
        agent.config.llm.provider,
        agent.config.llm.model,
      );
      const adjustment = describeReasoningAdjustment(options.reasoning, control);
      if (adjustment) {
        process.stderr.write(
          `Warning: --reasoning ${options.reasoning}: ${agent.config.llm.provider}/${agent.config.llm.model}: ${adjustment}\n`,
        );
      }
    }

    const ephemeral = options.ephemeral === true;
    const conversationKey = ephemeral ? undefined : options.conversationId?.trim();
    if (conversationKey !== undefined && conversationKey.length === 0) {
      return yield* failOneShot("Invalid --conversation id: must be non-empty.", outputOptions);
    }

    const priorRecord =
      conversationKey !== undefined ? yield* loadConversation(agent.id, conversationKey) : null;

    // A resumed conversation loads post-compaction messages, so anything compaction
    // dropped is missing from them. The journal is the only surviving copy; fold it back
    // in ahead of the persisted history.
    // Not gated on `priorRecord`: conversation history is saved only when a run
    // finishes, so a run killed mid-flight leaves none — and that is exactly the case
    // where the journal is the only surviving record. Requiring a prior record made the
    // journal unreadable in the one situation it exists for.
    const workStatePreamble =
      conversationKey !== undefined
        ? yield* buildWorkStatePreamble(agent.id, conversationKey, {
            modelHint: {
              provider: agentForRun.config.llm.provider,
              modelId: agentForRun.config.llm.model,
            },
          })
        : undefined;

    const resumedHistory = composeResumedHistory(priorRecord, workStatePreamble);

    // Ephemeral runs do not use Jazz's conversation persistence, so prior context
    // (if any) comes back inline rather than from a `--conversation` load. File
    // tools and telemetry are intentionally unaffected by this flag.
    const inlineHistory =
      ephemeral && framedHistory !== undefined
        ? stripMemorySources(framedHistory as ChatMessage[])
        : undefined;

    const autoApprovePolicy: AutoApprovePolicy | undefined = options.approvalPolicy;
    // Not a run id: a run's identity is the uuid the metrics mint, and this is the
    // conversation this turn belongs to. Without `--conversation` the caller wants a clean
    // slate, so the turn gets a conversation of its own that nothing will ever reuse.
    const conversationId = conversationKey ?? generateConversationId("once");

    // One-shot runs do not go through ChatService, so they must dispatch their own
    // lifecycle events. Await the dispatch: unlike an interactive session, this
    // process exits immediately after printing the answer and a detached effect
    // could be terminated before the plugin writes its terminal notification.
    const emitLifecycle = (
      event: LifecycleEventId,
      data?: Readonly<Record<string, JsonValue>>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
        if (Option.isNone(runtimeOption)) return;
        yield* runtimeOption.value.emitLifecycleEvent({
          event,
          agentId: agent.id,
          conversationId,
          cwd: process.cwd(),
          ...(data !== undefined ? { data } : {}),
        });
      }).pipe(Effect.catchAll(() => Effect.void));

    yield* emitLifecycle("user-prompt", { prompt: prompt.slice(0, 2000) });

    const runEffect = AgentRunner.run({
      agent: agentForRun,
      userInput: prompt,
      trustUserInputAsMemorySource: promptFromArgument || options.inputStdin === true,
      conversationId,
      origin: { source: "run" },
      ...(inlineHistory !== undefined
        ? { conversationHistory: inlineHistory }
        : resumedHistory !== null
          ? { conversationHistory: resumedHistory }
          : {}),
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      ...(options.autoApprovedTools?.length
        ? { autoApprovedTools: options.autoApprovedTools }
        : {}),
      ...(options.proposeGoals === true ? { offersGoalProposals: true } : {}),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
      ...(options.maxSubagentIterations != null
        ? { maxSubagentIterations: options.maxSubagentIterations }
        : {}),
      ...(options.maxIterations != null ? { maxIterations: options.maxIterations } : {}),
      ...(options.maxCostUSD != null ? { maxCostUSD: options.maxCostUSD } : {}),
      ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
      ...(options.maxDurationMs != null ? { maxDurationMs: options.maxDurationMs } : {}),
      ...(options.stream !== undefined ? { stream: options.stream } : {}),
      ...(interactiveInput.interactive ? {} : { withholdInteractiveTools: true }),
      ...(ephemeral ? { disablePersistence: true } : {}),
      ...(options.park === true ? { parkWhenUnattended: true } : {}),
      onRunSpend: (spend) => {
        runSpend = runSpendAsCallSpend(
          spend,
          agentForRun.config.llm.provider,
          agentForRun.config.llm.model,
        );
      },
      onToolBatchStopped: (calls) => {
        stoppedToolCalls = calls;
      },
    });

    const runResult = yield* (
      deadline ? Effect.raceFirst(runEffect, deadline.watch) : runEffect
    ).pipe(
      Effect.tap((response) => {
        const outcome = judgeAnswer(response);
        return outcome.kind === "failed"
          ? emitLifecycle("run-failed", { error: outcome.message })
          : emitLifecycle("run-complete", {
              prompt: prompt.slice(0, 2000),
              summary: response.content.slice(0, 2000),
            });
      }),
      Effect.tapError((error) =>
        isRunParkRequested(error)
          ? Effect.void
          : emitLifecycle("run-failed", { error: String(error).slice(0, 2000) }),
      ),
    );

    if (conversationKey !== undefined) {
      const record = buildConversation({
        agentId: agent.id,
        conversationId: conversationKey,
        prompt,
        priorRecord,
        responseContent: runResult.content,
        responseMessages: runResult.messages,
        now: new Date().toISOString(),
      });
      // A failed save must not discard the answer the run already produced —
      // warn on stderr (stdout stays the clean payload) and continue.
      yield* saveConversation(record).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            process.stderr.write(
              `Warning: failed to save conversation "${conversationKey}": ${getErrorMessage(error)}\n`,
            );
          }),
        ),
      );
    }

    const promptTokens = runResult.usage?.promptTokens ?? 0;
    const completionTokens = runResult.usage?.completionTokens ?? 0;
    const toolCalls = (runResult.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    }));
    const composition = extractCompositionResult(runResult.toolResults);
    const artifacts = runResult.artifacts ?? [];

    const verdict = judgeAnswer(runResult);
    if (verdict.kind === "failed") {
      return yield* failOneShot(verdict.message, outputOptions, runSpend, {
        code: verdict.code,
        ...(runResult.finishReason !== undefined ? { finishReason: runResult.finishReason } : {}),
        ...(runResult.toolsDisabled === true ? { toolsDisabled: true } : {}),
      });
    }

    yield* writeStdout(
      formatOneShotResult(
        {
          answer: runResult.content,
          costUSD: runResult.costUSD ?? 0,
          costKnown: isRunCostKnown(
            runResult.costUSD,
            agentForRun.config.llm.provider,
            agentForRun.config.llm.model,
            runResult.costIncomplete === true,
          ),
          ...(runResult.costCapped === true ? { costCapped: true } : {}),
          ...(runResult.tokenCapped === true ? { tokenCapped: true } : {}),
          ...(runResult.durationCapped === true ? { durationCapped: true } : {}),
          ...answerOutcomeFields(runResult),
          ...(runResult.stalled === true ? { stalled: true } : {}),
          ...(runResult.stoppedToolCalls !== undefined
            ? { stoppedToolCalls: runResult.stoppedToolCalls }
            : {}),
          tokenUsage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            ...(runResult.usage?.cacheReadTokens !== undefined && {
              cacheReadTokens: runResult.usage.cacheReadTokens,
            }),
          },
          toolCalls,
          ...(composition ? { composition } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(ephemeral ? { messages: runResult.messages ?? [] } : {}),
        },
        outputOptions,
      ),
    );
  }).pipe(
    Effect.catchIf(
      // A park that never reached the store carries no run id, so there is nothing to
      // resume and it falls through to the ordinary failure path below.
      (error): error is RunParkRequested => isRunParkRequested(error) && error.runId !== undefined,
      (parked) =>
        Effect.sync(() => {
          const formatted = formatOneShotParked(
            {
              runId: parked.runId ?? "",
              expiresAt: parked.expiresAt ?? "",
              pending: parked.pending,
            },
            outputOptions,
            parked.costUSD ?? 0,
          );
          if (outputOptions.json) {
            process.stdout.write(formatted);
          } else {
            process.stderr.write(formatted);
          }
          // Distinct from 1 so a caller can tell "come back to this" from "this failed".
          process.exitCode = ONE_SHOT_EXIT.parked;
        }),
    ),
    Effect.catchAll((error) =>
      failOneShot(
        getErrorMessage(error),
        outputOptions,
        runSpend,
        stoppedToolCalls !== undefined ? { stoppedToolCalls } : {},
      ),
    ),
    // A run that parked, failed or hit a spend cap may have queued a notification.
    Effect.ensuring(drainNotifyOutbox().pipe(Effect.ignore)),
    // Only a parking run needs somewhere durable to park. Without the flag no store is in
    // the layer at all, and the recorder is a pass-through.
    Effect.provide(options.park === true ? makeFileRunStoreLayer() : Layer.empty),
    Effect.provide(
      makeOneShotPresentationServiceLayer(
        options.eventTypes ?? new Set(),
        deadline && options.timeoutMs != null
          ? () => deadline.extend(options.timeoutMs!)
          : undefined,
        interactiveInput.interactive ? (interactiveInput.viaTty ? "tty" : "protocol") : "none",
      ),
    ),
  );
}

import {
  loadConversation,
  saveConversation,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { buildWorkStatePreamble } from "@jazz/core/agent/context/work-state-preamble";
import { RunParkRequested, isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { CommonSuggestions, getErrorMessage } from "@jazz/core/presentation/error-handler";
import {
  detectInteractiveInput,
  makeOneShotPresentationServiceLayer,
} from "@jazz/core/presentation/oneshot-presentation-service";
import { AgentNotFoundError } from "@jazz/core/types/errors";
import type { PerceptionCapability } from "@jazz/core/types/llm";
import type { ChatMessage } from "@jazz/core/types/message";
import type { StreamEvent } from "@jazz/core/types/streaming";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { createRunDeadline } from "@jazz/core/utils/run-deadline";
import { Effect, Layer } from "effect";
import {
  ONE_SHOT_EXIT,
  formatOneShotError,
  formatOneShotParked,
  formatOneShotResult,
  isRunCostKnown,
  type OneShotOutputOptions,
  type OneShotWebApp,
} from "./envelope";
import type { ApprovalPolicyFlag, ReasoningEffort } from "./flags";

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
 * Narrow `create_web_app`'s structured tool result (last call wins if invoked
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

export function extractWebAppResult(
  toolResults: Record<string, unknown> | undefined,
): OneShotWebApp | undefined {
  const raw = toolResults?.["create_web_app"];
  if (!raw || typeof raw !== "object") return undefined;

  const data = raw as Record<string, unknown>;
  if (
    typeof data["id"] !== "string" ||
    (data["mode"] !== "static" && data["mode"] !== "interactive") ||
    typeof data["title"] !== "string" ||
    typeof data["htmlPath"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: data["id"],
    mode: data["mode"],
    title: data["title"],
    htmlPath: data["htmlPath"],
    ...(typeof data["imagePath"] === "string" ? { imagePath: data["imagePath"] } : {}),
  };
}

export interface RunAgentOnceOptions {
  readonly json: boolean;
  readonly approvalPolicy?: ApprovalPolicyFlag | undefined;
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
  readonly reasoningEffort?: ReasoningEffort | undefined;
  /**
   * Per-run companion bindings overriding the agent's own `config.companions`.
   * A bound companion is what lets an unattended run delegate perception without
   * a human to pick the model.
   */
  readonly companions?: Partial<Record<PerceptionCapability, `${string}/${string}`>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxIterations?: number | undefined;
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
   * Inline JSON-encoded `ChatMessage[]` of prior turns, used only with
   * `ephemeral` in place of `--conversation` — the caller (e.g. a webhook
   * bridge) holds the transcript itself and passes it back in each call
   * instead of it living on disk. Malformed JSON is treated as "no history".
   */
  readonly historyJson?: string | undefined;
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
    endedAt: params.now,
    messages,
  };
}

function readStdin(): Promise<string> {
  // Relies on the prompt being passed as a CLI argument in flows (e.g. the
  // Telegram bridge) that also expect `OneShotPresentationService` to read
  // approval decisions from this same stdin stream — reading the prompt here
  // AND approval lines there would race over one stream.
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
  costUSD = 0,
): Effect.Effect<void, never> =>
  Effect.sync(() => {
    const formatted = formatOneShotError(message, options, costUSD);
    // JSON mode keeps the single-object stdout contract; plain mode sends the
    // human-readable error to stderr so stdout stays empty on failure.
    if (options.json) {
      process.stdout.write(formatted);
    } else {
      process.stderr.write(formatted);
    }
    process.exitCode = ONE_SHOT_EXIT.failed;
  });

/**
 * Run an agent once against a dynamic prompt and print a clean payload.
 *
 * The prompt comes from the positional argument or, when absent, piped stdin —
 * webhook text is untrusted and stdin avoids shell-escaping it.
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

  return Effect.gen(function* () {
    const normalizedIdentifier = agentIdentifier.trim();
    if (normalizedIdentifier.length === 0) {
      return yield* failOneShot("No agent specified. Use --agent <agentId>.", outputOptions);
    }

    let prompt = promptArg ?? "";
    if (prompt.trim().length === 0 && !process.stdin.isTTY) {
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
      options.reasoningEffort !== undefined || options.companions !== undefined
        ? {
            ...agent,
            config: {
              ...agent.config,
              ...(options.reasoningEffort !== undefined
                ? { reasoningEffort: options.reasoningEffort }
                : {}),
              ...(options.companions !== undefined ? { companions: options.companions } : {}),
            },
          }
        : agent;

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
              provider: agentForRun.config.llmProvider,
              modelId: agentForRun.config.llmModel,
            },
          })
        : undefined;

    const resumedHistory = composeResumedHistory(priorRecord, workStatePreamble);

    // Ephemeral runs never touch disk, so prior context (if any) comes back
    // in as inline JSON from the caller rather than a `--conversation` load.
    let inlineHistory: ChatMessage[] | undefined;
    if (ephemeral && options.historyJson !== undefined) {
      try {
        const parsed: unknown = JSON.parse(options.historyJson);
        if (Array.isArray(parsed)) inlineHistory = parsed as ChatMessage[];
      } catch {
        // Malformed inline history starts the run fresh rather than failing it.
      }
    }

    const autoApprovePolicy: AutoApprovePolicy | undefined = options.approvalPolicy;
    // Not a run id: a run's identity is the uuid the metrics mint, and this is the
    // conversation this turn belongs to. Without `--conversation` the caller wants a clean
    // slate, so the turn gets a conversation of its own that nothing will ever reuse.
    const conversationId = conversationKey ?? generateConversationId("once");
    const runEffect = AgentRunner.run({
      agent: agentForRun,
      userInput: prompt,
      conversationId,
      ...(inlineHistory !== undefined
        ? { conversationHistory: inlineHistory }
        : resumedHistory !== null
          ? { conversationHistory: resumedHistory }
          : {}),
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      ...(options.autoApprovedTools?.length
        ? { autoApprovedTools: options.autoApprovedTools }
        : {}),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
      ...(options.maxIterations != null ? { maxIterations: options.maxIterations } : {}),
      ...(options.stream !== undefined ? { stream: options.stream } : {}),
      ...(interactiveInput.interactive ? {} : { withholdInteractiveTools: true }),
      ...(ephemeral ? { disablePersistence: true } : {}),
      ...(options.park === true ? { parkWhenUnattended: true } : {}),
    });

    const runResult = yield* deadline ? Effect.race(runEffect, deadline.watch) : runEffect;

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
    const webApp = extractWebAppResult(runResult.toolResults);
    const artifacts = runResult.artifacts ?? [];

    yield* writeStdout(
      formatOneShotResult(
        {
          answer: runResult.content,
          costUSD: runResult.costUSD ?? 0,
          costKnown: isRunCostKnown(
            runResult.costUSD,
            agentForRun.config.llmProvider,
            agentForRun.config.llmModel,
            runResult.costIncomplete === true,
          ),
          tokenUsage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            ...(runResult.usage?.cacheReadTokens !== undefined && {
              cacheReadTokens: runResult.usage.cacheReadTokens,
            }),
          },
          toolCalls,
          ...(webApp ? { webApp } : {}),
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
          const request =
            parked.pending.kind === "tool-approval" ? parked.pending.request : undefined;
          const formatted = formatOneShotParked(
            {
              runId: parked.runId ?? "",
              expiresAt: parked.expiresAt ?? "",
              toolName: request?.toolName ?? "",
              toolCallId: request?.toolCallId ?? "",
              message: request?.message ?? "Waiting for input.",
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
    Effect.catchAll((error) => failOneShot(getErrorMessage(error), outputOptions)),
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

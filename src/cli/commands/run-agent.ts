import { Duration, Effect } from "effect";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier } from "@/core/agent/agent-service";
import { OneShotPresentationServiceLayer } from "@/core/presentation/oneshot-presentation-service";
import { AgentNotFoundError } from "@/core/types/errors";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { CommonSuggestions, getErrorMessage } from "@/core/utils/error-handler";

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
 */

export interface OneShotTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface OneShotToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface OneShotSuccess {
  readonly answer: string;
  readonly costUSD: number;
  readonly tokenUsage: OneShotTokenUsage;
  readonly toolCalls: readonly OneShotToolCall[];
}

export interface OneShotOutputOptions {
  readonly json: boolean;
}

/**
 * Format a successful run for stdout.
 *
 * Plain mode returns just the trimmed answer (raw markdown, ready to be
 * translated to Slack mrkdwn / Google Chat formatting downstream). JSON mode
 * returns exactly one single-line envelope.
 */
export function formatOneShotResult(result: OneShotSuccess, options: OneShotOutputOptions): string {
  if (!options.json) {
    return `${result.answer.trim()}\n`;
  }

  return `${JSON.stringify({
    ok: true,
    answer: result.answer,
    costUSD: result.costUSD,
    tokenUsage: result.tokenUsage,
    toolCalls: result.toolCalls,
  })}\n`;
}

/** Format a failure (plain message to stderr, or JSON envelope to stdout in --json mode). */
export function formatOneShotError(
  message: string,
  options: OneShotOutputOptions,
  costUSD = 0,
): string {
  return options.json
    ? `${JSON.stringify({ ok: false, error: message, costUSD })}\n`
    : `${message}\n`;
}

const VALID_APPROVAL_POLICIES = ["read-only", "low-risk", "high-risk"] as const;
export type ApprovalPolicyFlag = (typeof VALID_APPROVAL_POLICIES)[number];

export function isApprovalPolicyFlag(value: string): value is ApprovalPolicyFlag {
  return (VALID_APPROVAL_POLICIES as readonly string[]).includes(value);
}

export interface RunAgentOnceOptions {
  readonly json: boolean;
  readonly approvalPolicy?: ApprovalPolicyFlag | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxIterations?: number | undefined;
}

function readStdin(): Promise<string> {
  // If stdin already ended, the "end" event has fired and won't fire again —
  // registering a new listener would hang forever.
  if (process.stdin.readableEnded) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
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
    process.exitCode = 1;
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

    const autoApprovePolicy: AutoApprovePolicy | undefined = options.approvalPolicy;
    const runId = `run-${agent.id}-${Date.now()}`;
    const runEffect = AgentRunner.run({
      agent,
      userInput: prompt,
      sessionId: runId,
      conversationId: runId,
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
      ...(options.maxIterations != null ? { maxIterations: options.maxIterations } : {}),
    });

    const runResult = yield* options.timeoutMs != null
      ? runEffect.pipe(
          Effect.timeoutFail({
            duration: Duration.millis(options.timeoutMs),
            onTimeout: () => new Error(`Run exceeded the ${options.timeoutMs}ms timeout.`),
          }),
        )
      : runEffect;

    const promptTokens = runResult.usage?.promptTokens ?? 0;
    const completionTokens = runResult.usage?.completionTokens ?? 0;
    const toolCalls = (runResult.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    }));

    yield* writeStdout(
      formatOneShotResult(
        {
          answer: runResult.content,
          costUSD: runResult.costUSD ?? 0,
          tokenUsage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          toolCalls,
        },
        outputOptions,
      ),
    );
  }).pipe(
    Effect.catchAll((error) => failOneShot(getErrorMessage(error), outputOptions)),
    Effect.provide(OneShotPresentationServiceLayer),
  );
}

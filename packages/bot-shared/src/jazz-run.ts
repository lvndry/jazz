/**
 * @fileoverview Run one Jazz turn for a conversation and narrate it.
 *
 * Every bridge does the same thing with `jazz run`: spawn it inside the
 * conversation's sandbox with `--json --events … --interactive-stdin`, read the
 * NDJSON event stream off stderr while it works, answer whatever it blocks on
 * over stdin, and parse the single JSON envelope it prints on stdout at the
 * end. That was copied verbatim into the Telegram and Discord bridges and is
 * the part with the sharp edges — the envelope is the *last* JSON line, not the
 * whole of stdout; a run parked on an approval never exits unless something
 * writes a decision; the kill timer has to outlive Jazz's own `--timeout` or it
 * races it.
 *
 * None of that is surface-specific, so it lives here and the surfaces only
 * decide how to put the events on screen.
 */

import { type ChatSandbox, sandboxCommand, sandboxEnv } from "./chat-sandbox";

/** A subset of Jazz's NDJSON stream events (`jazz run --events`); other fields ignored. */
export interface JazzEvent {
  readonly type: string;
  readonly toolName?: string;
  readonly content?: string;
  readonly approved?: boolean;
  readonly task?: string;
  readonly toolCallId?: string;
  readonly message?: string;
  readonly previewDiff?: string;
  /** `user_input_required`: the agent is blocked on a question for the human. */
  readonly requestId?: string;
  readonly question?: string;
  readonly suggestions?: readonly { value: string; label?: string; description?: string }[];
}

export interface JazzWebApp {
  readonly id: string;
  readonly mode: "static" | "interactive";
  readonly title: string;
  readonly htmlPath: string;
  readonly imagePath?: string;
}

export interface JazzSuccessEnvelope {
  readonly ok: true;
  readonly answer: string;
  readonly costUSD: number;
  readonly costKnown?: boolean;
  readonly tokenUsage?: {
    readonly totalTokens?: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly cacheReadTokens?: number;
  };
  readonly webApp?: JazzWebApp;
  /**
   * Only present for `--ephemeral` runs (incognito conversations): the full
   * transcript, opaque to the bridge, round-tripped back in as `--history-json`
   * on that conversation's next turn instead of being loaded from disk.
   */
  readonly messages?: unknown[];
}

export interface JazzErrorEnvelope {
  readonly ok: false;
  readonly error: string;
}

export type JazzEnvelope = JazzSuccessEnvelope | JazzErrorEnvelope;

/**
 * Where this turn's history comes from.
 *
 * `persistent` names a conversation Jazz loads and appends to on disk;
 * `ephemeral` hands the prior transcript in on the command line and gets the
 * new one back in the envelope, so an incognito chat's context never lands in
 * a file.
 */
export type ConversationSource =
  | { readonly kind: "persistent"; readonly key: string }
  | { readonly kind: "ephemeral"; readonly history: readonly unknown[] };

export interface JazzRunOptions {
  readonly jazzBinary: string;
  readonly agentId: string;
  readonly sandbox: ChatSandbox;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly timezone: string;
  readonly runTimeoutMs: number;
  readonly conversation: ConversationSource;
  readonly prompt: string;
}

export interface JazzRunHandlers {
  /** Every parsed event, in arrival order. */
  readonly onEvent?: (event: JazzEvent) => void;
  /** A tool is parked waiting for a human; answer with `approve`. */
  readonly onApprovalRequired?: (event: JazzEvent) => void;
  /** The agent asked the human a question; answer with `answerQuestion`. */
  readonly onUserInputRequired?: (event: JazzEvent) => void;
}

export interface JazzRun {
  /** Resolves with the envelope once the process exits, and never rejects. */
  readonly result: Promise<JazzEnvelope>;
  /** True once `cancel()` was called, so the caller can report it as a cancel. */
  cancelled(): boolean;
  approve(decisions: readonly { toolCallId: string; approved: boolean }[]): Promise<void>;
  answerQuestion(requestId: string, response: string): Promise<void>;
  cancel(): void;
}

/**
 * The kill timer's headroom over Jazz's own `--timeout`.
 *
 * Jazz stops itself at `runTimeoutMs` and still has to serialise an envelope
 * and flush it; killing it at exactly the same moment would turn a clean
 * timeout message into "no JSON envelope". This is the grace for that shutdown,
 * not a second timeout budget.
 */
const KILL_GRACE_MS = 15_000;

/** How many stderr lines to keep for the log when a run produces no envelope. */
const STDERR_TAIL_LINES = 50;

function buildArgs(options: JazzRunOptions): string[] {
  const conversationArgs =
    options.conversation.kind === "ephemeral"
      ? [
          "--ephemeral",
          ...(options.conversation.history.length > 0
            ? ["--history-json", JSON.stringify(options.conversation.history)]
            : []),
        ]
      : ["--conversation", options.conversation.key];

  return [
    options.jazzBinary,
    "run",
    "--no-tui",
    "--json",
    "--events",
    "tools,reasoning,text,approval,subagent",
    "--interactive-stdin",
    "--agent",
    options.agentId,
    "--approval-policy",
    options.approvalPolicy,
    ...(options.autoApproveTools.length > 0
      ? ["--auto-approve-tools", options.autoApproveTools.join(",")]
      : []),
    "--timezone",
    options.timezone,
    ...conversationArgs,
    "--timeout",
    String(options.runTimeoutMs),
    options.prompt,
  ];
}

/** Read a byte stream and invoke `onLine` for each newline-delimited line. */
export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        onLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

/**
 * The envelope is the last JSON line on stdout, not the whole of it: a run can
 * print progress lines before it, and taking the first or the concatenation
 * gets a parse error on a perfectly good run.
 */
export function parseEnvelope(stdout: string): JazzEnvelope | undefined {
  const lastJsonLine = stdout
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.startsWith("{"))
    .at(-1);
  if (lastJsonLine === undefined) return undefined;
  try {
    return JSON.parse(lastJsonLine) as JazzEnvelope;
  } catch {
    return undefined;
  }
}

/**
 * Spawn the turn and return immediately with handles onto it.
 *
 * Returning before the run finishes is the point: an approval or a question
 * arrives *during* it and has to be answered over the still-open stdin, so a
 * shape that only handed back a promise could never unblock its own run.
 */
export function startJazzRun(options: JazzRunOptions, handlers: JazzRunHandlers = {}): JazzRun {
  const child = Bun.spawn(sandboxCommand(options.sandbox, buildArgs(options)), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: sandboxEnv(options.sandbox, process.env),
  });

  let cancelled = false;
  const timeout = setTimeout(() => child.kill(), options.runTimeoutMs + KILL_GRACE_MS);

  const stderrTail: string[] = [];
  const stderrDone = streamLines(child.stderr, (rawLine) => {
    if (stderrTail.length < STDERR_TAIL_LINES) stderrTail.push(rawLine);
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{")) return;
    let event: JazzEvent;
    try {
      event = JSON.parse(trimmed) as JazzEvent;
    } catch {
      // Non-event stderr line (plain log chatter) — ignore.
      return;
    }
    if (typeof event.type !== "string") return;
    handlers.onEvent?.(event);
    if (event.type === "approval_required" && event.toolCallId) {
      handlers.onApprovalRequired?.(event);
    }
    if (event.type === "user_input_required" && event.requestId) {
      handlers.onUserInputRequired?.(event);
    }
  });

  /**
   * Bun's FileSink buffers, so a decision written without a flush can sit in
   * the buffer while the run it unblocks waits for it — a deadlock that looks
   * exactly like a hung agent.
   */
  const writeStdin = async (payload: unknown): Promise<void> => {
    try {
      await child.stdin.write(`${JSON.stringify(payload)}\n`);
      await child.stdin.flush();
    } catch (error) {
      console.error(`Failed to write to the Jazz run's stdin: ${String(error)}`);
    }
  };

  const result = (async (): Promise<JazzEnvelope> => {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      stderrDone,
      child.exited,
    ]);
    clearTimeout(timeout);

    const envelope = parseEnvelope(stdout);
    if (envelope === undefined) {
      console.error(
        `Jazz produced no JSON envelope (exit ${exitCode}). stderr:\n${stderrTail.join("\n")}`,
      );
      return { ok: false, error: "Jazz did not return a response." };
    }
    return envelope;
  })();

  return {
    result,
    cancelled: () => cancelled,
    approve: async (decisions) => {
      for (const { toolCallId, approved } of decisions) {
        await writeStdin({ type: "approval_decision", toolCallId, approved });
      }
    },
    answerQuestion: (requestId, response) =>
      writeStdin({ type: "user_input_response", requestId, response }),
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}

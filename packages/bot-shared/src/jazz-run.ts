/**
 * @fileoverview Run one Jazz turn for a conversation and narrate it.
 *
 * Every bridge does the same thing with `jazz run`: spawn it inside the
 * conversation's sandbox with `--json --events … --interactive-stdin --input-stdin`,
 * write the person's message as the first stdin line, read the NDJSON event
 * stream off stderr while it works, answer whatever it blocks on over the same
 * stdin, and parse the single JSON envelope it prints on stdout at the end.
 *
 * The message and an incognito transcript never go on argv: every account on
 * the host reads another process's arguments through `ps`, a leading `-` would
 * parse as a flag, and Linux caps one argument at 128 KiB. That was copied verbatim into the Telegram and Discord bridges and is
 * the part with the sharp edges — the envelope is the *last* JSON line, not the
 * whole of stdout; a run parked on an approval never exits unless something
 * writes a decision; the kill timer has to outlive Jazz's own `--timeout` or it
 * races it.
 *
 * None of that is surface-specific, so it lives here and the surfaces only
 * decide how to put the events on screen.
 */

import { bridgeRunEnv, type ChatSandbox, sandboxCommand } from "./chat-sandbox";
import { runSpendFromEvent, spendFields, type RunSpend } from "./usage-store";

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
  /** `user_secret_required`: what the secret is for, and the name it is held under. */
  readonly prompt?: string;
  readonly name?: string;
  /** `run_spend`: what the run has spent so far. */
  readonly costUSD?: number;
  readonly costIncomplete?: boolean;
  readonly totalTokens?: number;
}

/**
 * The `--events` categories every bridge asks `jazz run` for. `spend` streams `run_spend`
 * events, so a run the bridge cancels, which leaves no envelope, is still paid for.
 */
export const JAZZ_RUN_EVENT_CATEGORIES = "tools,reasoning,text,approval,subagent,spend";

export interface JazzComposition {
  readonly id: string;
  readonly mode: "static" | "interactive";
  readonly title: string;
  readonly sessionId: string;
  readonly filename: string;
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
  readonly composition?: JazzComposition;
  /** True when the agent has tools but none were sent: the model could only reply in text. */
  readonly toolsDisabled?: boolean;
  /** True when the answer was cut off at the model's output limit. */
  readonly truncated?: boolean;
  /** True when the run used every allowed iteration without a final answer. */
  readonly iterationLimited?: boolean;
  /**
   * Only present for `--ephemeral` runs (incognito conversations): the full
   * transcript, opaque to the bridge, round-tripped back in as the stdin
   * frame's `history` on that conversation's next turn instead of being loaded
   * from disk.
   */
  readonly messages?: unknown[];
}

export interface JazzErrorEnvelope {
  readonly ok: false;
  readonly error: string;
  /** Present once the run reached the model: a failed run still spent money. */
  readonly costUSD?: number;
  readonly costKnown?: boolean;
  readonly tokenUsage?: { readonly totalTokens?: number };
}

export type JazzEnvelope = JazzSuccessEnvelope | JazzErrorEnvelope;

/**
 * Where this turn's history comes from.
 *
 * `persistent` names a conversation Jazz loads and appends to on disk;
 * `ephemeral` hands the prior transcript in on stdin and gets the new one back
 * in the envelope, so an incognito chat's context never lands in
 * a file.
 */
export type ConversationSource =
  | { readonly kind: "persistent"; readonly key: string }
  | { readonly kind: "ephemeral"; readonly history: readonly unknown[] };

export interface JazzRunOptions {
  readonly jazzBinary: string;
  /** The surface's name, recorded by the run as `JAZZ_SURFACE`. */
  readonly surface: string;
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
  /** The agent asked the human to type a secret; answer with `answerSecret`. */
  readonly onUserSecretRequired?: (event: JazzEvent) => void;
}

/**
 * What the person did about a secret: typed it, declined, or could not be asked safely because
 * the chat is shared with other people.
 */
export type SecretAnswer =
  | { readonly kind: "provided"; readonly value: string }
  | { readonly kind: "declined" }
  | { readonly kind: "shared-chat" };

export interface JazzRun {
  /** Resolves with the envelope once the process exits, and never rejects. */
  readonly result: Promise<JazzEnvelope>;
  /** True once `cancel()` was called, so the caller can report it as a cancel. */
  cancelled(): boolean;
  /** The spend the last `run_spend` event reported, for a run that leaves no envelope. */
  lastSpend(): RunSpend | undefined;
  approve(decisions: readonly { toolCallId: string; approved: boolean }[]): Promise<void>;
  answerQuestion(requestId: string, response: string): Promise<void>;
  /** Hand the run a secret over its stdin pipe; the value is written nowhere else. */
  answerSecret(requestId: string, answer: SecretAnswer): Promise<void>;
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

/**
 * The command line of a turn. Carries no message text: the prompt and any
 * incognito history go in the stdin frame (`stdinFrame`).
 */
export function buildJazzRunArgs(options: JazzRunOptions): string[] {
  const conversationArgs =
    options.conversation.kind === "ephemeral"
      ? ["--ephemeral"]
      : ["--conversation", options.conversation.key];

  return [
    options.jazzBinary,
    "run",
    "--no-tui",
    "--json",
    "--events",
    JAZZ_RUN_EVENT_CATEGORIES,
    "--interactive-stdin",
    "--input-stdin",
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
  ];
}

/** The first stdin line `jazz run --input-stdin` reads: the message and incognito history. */
export interface StdinFrame {
  readonly prompt: string;
  readonly history?: readonly unknown[];
}

export function stdinFrame(options: Pick<JazzRunOptions, "prompt" | "conversation">): StdinFrame {
  return options.conversation.kind === "ephemeral" && options.conversation.history.length > 0
    ? { prompt: options.prompt, history: options.conversation.history }
    : { prompt: options.prompt };
}

/**
 * Write the frame to a run started with `--input-stdin` and flush it.
 *
 * For a caller that owns the process itself; `startJazzRun` writes its own.
 */
export async function writeStdinFrame(
  child: { readonly stdin: Bun.FileSink },
  frame: StdinFrame,
): Promise<void> {
  try {
    await child.stdin.write(`${JSON.stringify(frame)}\n`);
    await child.stdin.flush();
  } catch (error) {
    console.error(`Failed to write the Jazz run's input: ${String(error)}`);
  }
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
 * A kill deadline that stops counting while the run waits on a person.
 *
 * Jazz extends its own `--timeout` while it is parked on an approval or a question, so a
 * human taking five minutes to tap Approve does not use up the agent's budget. The bridge's
 * kill timer has to do the same, or the tap lands on a process it already killed.
 */
export function createKillTimer(
  onExpire: () => void,
  budgetMs: number,
): { pause(): void; resume(): void; stop(): void } {
  let remainingMs = budgetMs;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onExpire, remainingMs);
  let stopped = false;
  return {
    pause() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remainingMs -= Date.now() - startedAt;
    },
    resume() {
      if (stopped || timer !== undefined) return;
      startedAt = Date.now();
      timer = setTimeout(onExpire, Math.max(0, remainingMs));
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The stdin line that answers a `user_secret_required` event. */
export function userSecretResponseLine(requestId: string, answer: SecretAnswer) {
  switch (answer.kind) {
    case "provided":
      return { type: "user_secret_response", requestId, value: answer.value };
    case "declined":
      return { type: "user_secret_response", requestId, declined: true };
    case "shared-chat":
      return { type: "user_secret_response", requestId, unavailable: "shared-chat" };
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
  const child = Bun.spawn(sandboxCommand(options.sandbox, buildJazzRunArgs(options)), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: bridgeRunEnv(options.sandbox, process.env, options.surface),
  });

  let cancelled = false;
  let lastSpend: RunSpend | undefined;
  const killTimer = createKillTimer(() => child.kill(), options.runTimeoutMs + KILL_GRACE_MS);
  /** Prompts the run is parked on, by id; the kill timer is paused while any are open. */
  const waitingOnHuman = new Set<string>();
  const humanAnswered = (id: string): void => {
    waitingOnHuman.delete(id);
    if (waitingOnHuman.size === 0) killTimer.resume();
  };

  const stderrTail: string[] = [];
  const stderrDone = streamLines(child.stderr, (rawLine) => {
    // The last lines, not the first: a crash is at the end of the stream.
    stderrTail.push(rawLine);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
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
    lastSpend = runSpendFromEvent(event) ?? lastSpend;
    handlers.onEvent?.(event);
    if (event.type === "approval_required" && event.toolCallId) {
      waitingOnHuman.add(event.toolCallId);
      killTimer.pause();
      handlers.onApprovalRequired?.(event);
    }
    if (event.type === "user_input_required" && event.requestId) {
      waitingOnHuman.add(event.requestId);
      killTimer.pause();
      handlers.onUserInputRequired?.(event);
    }
    if (event.type === "user_secret_required" && event.requestId) {
      waitingOnHuman.add(event.requestId);
      killTimer.pause();
      handlers.onUserSecretRequired?.(event);
    }
  });

  /**
   * Bun's FileSink buffers, so a decision written without a flush can sit in
   * the buffer while the run it unblocks waits for it — a deadlock that looks
   * exactly like a hung agent.
   *
   * Writes are chained so the input frame is always the first line, whatever
   * a caller answers before it has landed.
   */
  let stdinWrites: Promise<void> = Promise.resolve();
  const writeStdin = (payload: unknown): Promise<void> => {
    stdinWrites = stdinWrites.then(async () => {
      try {
        await child.stdin.write(`${JSON.stringify(payload)}\n`);
        await child.stdin.flush();
      } catch (error) {
        console.error(`Failed to write to the Jazz run's stdin: ${String(error)}`);
      }
    });
    return stdinWrites;
  };
  void writeStdin(stdinFrame(options));

  const result = (async (): Promise<JazzEnvelope> => {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      stderrDone,
      child.exited,
    ]);
    killTimer.stop();

    const envelope = parseEnvelope(stdout);
    if (envelope === undefined) {
      console.error(
        `Jazz produced no JSON envelope (exit ${exitCode}). stderr:\n${stderrTail.join("\n")}`,
      );
      return { ok: false, error: "Jazz did not return a response.", ...spendFields(lastSpend) };
    }
    return envelope;
  })();

  return {
    result,
    cancelled: () => cancelled,
    lastSpend: () => lastSpend,
    approve: async (decisions) => {
      for (const { toolCallId, approved } of decisions) {
        await writeStdin({ type: "approval_decision", toolCallId, approved });
        humanAnswered(toolCallId);
      }
    },
    answerQuestion: async (requestId, response) => {
      await writeStdin({ type: "user_input_response", requestId, response });
      humanAnswered(requestId);
    },
    answerSecret: async (requestId, answer) => {
      await writeStdin(userSecretResponseLine(requestId, answer));
      humanAnswered(requestId);
    },
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}

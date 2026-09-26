/**
 * User-facing status for a conversation handed to an operator-owned SSH host.
 * The remote host is the source of truth. A connection failure is reported as
 * unknown, never converted into a completed or failed run.
 */
import * as readline from "node:readline";
import type { TimedDetachEvent } from "@jazz/adapters/detach/events";
import chalk from "chalk";
import { Effect } from "effect";
import {
  answerDetachedTransfer,
  followDetachedEvents,
  getDetachStatus,
  listDetachTransfers,
  pullDetachedTransfer,
  reclaimDetachedTransfer,
  sendDetachedMessage,
  stopDetachedRun,
  type DetachReclaimResult,
  type LocalTransferRecord,
} from "@/cli/detach/orchestrator";
import { getGlyphs, type GlyphSet } from "@/cli/ui/glyphs";

type DetachStatus = Awaited<ReturnType<typeof getDetachStatus>>;
type DetachPull = Awaited<ReturnType<typeof pullDetachedTransfer>>;
/** How long the event stream must stay quiet before attach offers a prompt. */
const PROMPT_SETTLE_MS = 400;
const PATH_DISPLAY_LIMIT = 40;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep the real failure: a bare `Effect.tryPromise` replaces it with UnknownException. */
function attempt<T>(operation: () => Promise<T>) {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/** Keep host reachability and actual run outcomes visibly distinct. */
export function formatDetachStatus(status: DetachStatus): string {
  const detail = status.detail === undefined ? "" : `\n${JSON.stringify(status.detail)}`;
  const decision =
    status.state === "parked" && status.approvalAvailable !== false
      ? `\nAnswer: jazz detach approve ${status.handoffId} (or jazz detach reject ${status.handoffId})`
      : "";
  return `${status.handoffId} on ${status.hostName}: ${status.state}${detail}${decision}\n`;
}

/** Print the remote state of one handoff without inferring its outcome from SSH reachability. */
export function detachStatusCommand(handoffId: string) {
  return Effect.gen(function* () {
    const status = yield* attempt(() => getDetachStatus(handoffId));
    process.stdout.write(formatDetachStatus(status));
    if (status.state === "unknown") {
      process.exitCode = 2;
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not check detached run: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

/** Resolve the exact approval currently parked on a remote host. */
export function detachApprovalCommand(handoffId: string, approved: boolean) {
  return Effect.gen(function* () {
    const status = yield* attempt(() => answerDetachedTransfer(handoffId, approved));
    process.stdout.write(formatDetachStatus(status));
    if (status.state === "unknown") {
      process.exitCode = 2;
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(
          `Could not ${approved ? "approve" : "reject"} detached run: ${describeError(error)}\n`,
        );
        process.exitCode = 1;
      }),
    ),
  );
}

/** Describe downloaded work without implying it was applied to the current directory. */
export function formatDetachPull(pull: DetachPull): string {
  const lines = [
    `${pull.handoffId} from ${pull.hostName}: downloaded to ${JSON.stringify(pull.resultDirectory)}`,
    `${pull.changedPaths.length} changed path${pull.changedPaths.length === 1 ? "" : "s"}:`,
    ...formatPathList(pull.changedPaths),
    ...(pull.conflicts.length > 0
      ? [
          `${pull.conflicts.length} conflict${pull.conflicts.length === 1 ? "" : "s"} with local changes:`,
          ...formatPathList(pull.conflicts),
        ]
      : []),
    "Local files were not changed. This verified result requires manual reconciliation.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Download a remote result for review, leaving the local worktree untouched. */
export function detachPullCommand(handoffId: string) {
  return Effect.gen(function* () {
    const pull = yield* attempt(() => pullDetachedTransfer(handoffId));
    process.stdout.write(formatDetachPull(pull));
    if (pull.conflicts.length > 0) {
      process.exitCode = 2;
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not download detached result: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

function formatPathList(paths: readonly string[]): string[] {
  return [
    ...paths.slice(0, PATH_DISPLAY_LIMIT).map((relative) => `  ${JSON.stringify(relative)}`),
    ...(paths.length > PATH_DISPLAY_LIMIT
      ? [`  …and ${paths.length - PATH_DISPLAY_LIMIT} more`]
      : []),
  ];
}

/** One line per handoff, newest first. */
export function formatDetachList(records: readonly LocalTransferRecord[]): string {
  if (records.length === 0) {
    return "No handoffs yet. Move a conversation with /detach <host> in jazz chat.\n";
  }
  const lines = records.map(
    (record) =>
      `${record.handoffId}  ${record.host.name}  ${record.state}  ${chalk.dim(record.conversationId)}`,
  );
  return `${lines.join("\n")}\n`;
}

export function detachListCommand() {
  return Effect.gen(function* () {
    const records = yield* attempt(() => listDetachTransfers());
    process.stdout.write(formatDetachList(records));
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not list handoffs: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "queued",
  "answer-pending": "queued",
  "message-pending": "queued",
  running: "working",
  "answer-running": "working",
  "message-running": "working",
  completed: "finished, waiting for you",
  parked: "waiting for approval",
  failed: "failed",
  released: "handed back",
};

/**
 * Render one remote event for a line-oriented terminal. Returns the text to write; the
 * caller tracks whether the cursor sits mid-line after streamed answer text.
 */
export function formatDetachEvent(
  event: TimedDetachEvent,
  glyphs: GlyphSet,
  atLineStart: boolean,
): string {
  const lead = atLineStart ? "" : "\n";
  switch (event.type) {
    case "text":
      return event.delta;
    case "response_end":
      return atLineStart ? "" : "\n";
    case "user":
      return `${lead}\n${chalk.bold(`${glyphs.promptCursor} ${event.text}`)}\n\n`;
    case "tool_start":
      return `${lead}  ${chalk.dim(glyphs.bullet)} ${event.toolName}${
        event.arguments !== undefined ? chalk.dim(` ${event.arguments}`) : ""
      }\n`;
    case "tool_end": {
      const marker = event.success ? chalk.green(glyphs.success) : chalk.red(glyphs.error);
      const seconds = `${(event.durationMs / 1000).toFixed(1)}s`;
      const summary = event.summary !== undefined ? ` ${event.summary}` : "";
      return `${lead}    ${marker}${chalk.dim(`${summary} ${seconds}`)}\n`;
    }
    case "error":
      return `${lead}${chalk.red(`${glyphs.error} ${event.message}`)}\n`;
    case "status": {
      const label = STATUS_LABELS[event.state] ?? event.state;
      const detail = event.detail !== undefined ? `: ${event.detail}` : "";
      return `${lead}${chalk.dim(`${glyphs.divider}${glyphs.divider} ${label}${detail}`)}\n`;
    }
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Watch a remote conversation live and steer it: reply when a turn finishes, answer a parked
 * approval. Leaving (Enter on an empty prompt, or Ctrl+C) never stops the remote run.
 */
async function attach(handoffId: string): Promise<void> {
  const glyphs = getGlyphs();
  const initial = await getDetachStatus(handoffId);
  process.stdout.write(
    chalk.dim(
      `Attached to ${handoffId} on ${initial.hostName}. Ctrl+C leaves; the remote run keeps going.\n`,
    ),
  );
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let atLineStart = true;
  /** The prompt already shows what the operator typed; skip its echo from the log once. */
  let echoedReply: string | undefined;
  let latestState: string | undefined;
  let prompting = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let leave: (reason?: string) => void = () => undefined;
  const left = new Promise<string | undefined>((resolve) => {
    leave = resolve;
  });

  const offerPrompt = async (): Promise<void> => {
    if (prompting || rl === undefined) {
      return;
    }
    prompting = true;
    try {
      if (latestState === "completed") {
        const reply = (await ask(rl, `${glyphs.promptCursor} `)).trim();
        if (reply.length === 0) {
          leave();
          return;
        }
        echoedReply = reply;
        await sendDetachedMessage(handoffId, reply);
      } else if (latestState === "parked") {
        for (;;) {
          const answer = (await ask(rl, "Approve? [y/n, Enter to leave] ")).trim().toLowerCase();
          if (answer === "y" || answer === "yes") {
            await answerDetachedTransfer(handoffId, true);
          } else if (answer === "n" || answer === "no") {
            await answerDetachedTransfer(handoffId, false);
          } else if (answer.length === 0) {
            leave();
          } else {
            continue;
          }
          break;
        }
      }
    } catch (error) {
      process.stdout.write(`${chalk.red(`${glyphs.error} ${describeError(error)}`)}\n`);
    } finally {
      prompting = false;
    }
  };

  const onSettled = (): void => {
    if (latestState === "failed" || latestState === "released") {
      leave(
        latestState === "failed"
          ? `Take the conversation back with: jazz detach reclaim ${handoffId}`
          : undefined,
      );
      return;
    }
    if (rl === undefined && (latestState === "completed" || latestState === "parked")) {
      leave();
      return;
    }
    void offerPrompt();
  };

  rl?.on("SIGINT", () => leave());
  rl?.on("close", () => leave());
  const stream = await followDetachedEvents(handoffId, 0, (event) => {
    const echo = event.type === "user" && event.text === echoedReply;
    if (echo) {
      echoedReply = undefined;
    }
    const output = echo ? "" : formatDetachEvent(event, glyphs, atLineStart);
    if (output.length > 0) {
      process.stdout.write(output);
      atLineStart = output.endsWith("\n");
    }
    if (event.type === "status") {
      latestState = event.state;
    }
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(onSettled, PROMPT_SETTLE_MS);
  });
  stream.done.then(
    () => leave(),
    (error: unknown) => leave(`Lost the connection: ${describeError(error)}`),
  );
  const reason = await left;
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
  }
  stream.stop();
  rl?.close();
  process.stdout.write(
    `${atLineStart ? "" : "\n"}${chalk.dim(
      reason ?? `Left ${handoffId}. Reattach with: jazz detach attach ${handoffId}`,
    )}\n`,
  );
}

export function detachAttachCommand(handoffId: string) {
  return attempt(() => attach(handoffId)).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not attach: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

export function detachCancelCommand(handoffId: string) {
  return Effect.gen(function* () {
    yield* attempt(() => stopDetachedRun(handoffId));
    process.stdout.write(`Cancellation sent to ${handoffId}.\n`);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not cancel detached run: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

/** Explain what came back, and what the operator must do when conflicts blocked it. */
export function formatDetachReclaim(result: DetachReclaimResult): string {
  const count = result.changedPaths.length;
  if (!result.applied) {
    return `${[
      `${result.handoffId}: the host released it, but ${result.conflicts.length} file${
        result.conflicts.length === 1 ? "" : "s"
      } changed both here and remotely:`,
      ...formatPathList(result.conflicts),
      "Nothing was written. Commit or stash your local edits and rerun, or pass --overwrite to let the remote version win.",
    ].join("\n")}\n`;
  }
  return `${[
    `${result.handoffId} is back from ${result.hostName}. ${count} file${count === 1 ? "" : "s"} updated${
      count > 0 ? ":" : "."
    }`,
    ...formatPathList(result.changedPaths),
    `Continue it with /resume in jazz chat (conversation ${result.conversationId}).`,
  ].join("\n")}\n`;
}

export function detachReclaimCommand(handoffId: string, options: { readonly overwrite: boolean }) {
  return Effect.gen(function* () {
    const result = yield* attempt(() =>
      reclaimDetachedTransfer(handoffId, { overwriteConflicts: options.overwrite }),
    );
    process.stdout.write(formatDetachReclaim(result));
    if (!result.applied) {
      process.exitCode = 2;
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not reclaim the conversation: ${describeError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

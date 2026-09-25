/**
 * User-facing status for a conversation handed to an operator-owned SSH host.
 * The remote host is the source of truth. A connection failure is reported as
 * unknown, never converted into a completed or failed run.
 */
import { Effect } from "effect";
import {
  answerDetachedTransfer,
  getDetachStatus,
  pullDetachedTransfer,
} from "@/cli/detach/orchestrator";

type DetachStatus = Awaited<ReturnType<typeof getDetachStatus>>;
type DetachPull = Awaited<ReturnType<typeof pullDetachedTransfer>>;

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
    const status = yield* Effect.tryPromise(() => getDetachStatus(handoffId));
    process.stdout.write(formatDetachStatus(status));
    if (status.state === "unknown") process.exitCode = 2;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not check detached run: ${String(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

/** Resolve the exact approval currently parked on a remote host. */
export function detachApprovalCommand(handoffId: string, approved: boolean) {
  return Effect.gen(function* () {
    const status = yield* Effect.tryPromise(() => answerDetachedTransfer(handoffId, approved));
    process.stdout.write(formatDetachStatus(status));
    if (status.state === "unknown") process.exitCode = 2;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(
          `Could not ${approved ? "approve" : "reject"} detached run: ${String(error)}\n`,
        );
        process.exitCode = 1;
      }),
    ),
  );
}

/** Describe downloaded work without implying it was applied to the current directory. */
export function formatDetachPull(pull: DetachPull): string {
  const displayLimit = 40;
  const lines = [
    `${pull.handoffId} from ${pull.hostName}: downloaded to ${JSON.stringify(pull.resultDirectory)}`,
    `${pull.changedPaths.length} changed path${pull.changedPaths.length === 1 ? "" : "s"}:`,
    ...pull.changedPaths.slice(0, displayLimit).map((path) => `  ${JSON.stringify(path)}`),
    ...(pull.changedPaths.length > displayLimit
      ? [`  …and ${pull.changedPaths.length - displayLimit} more`]
      : []),
    ...(pull.conflicts.length > 0
      ? [
          `${pull.conflicts.length} conflict${pull.conflicts.length === 1 ? "" : "s"} with local changes:`,
          ...pull.conflicts.slice(0, displayLimit).map((path) => `  ${JSON.stringify(path)}`),
          ...(pull.conflicts.length > displayLimit
            ? [`  …and ${pull.conflicts.length - displayLimit} more`]
            : []),
        ]
      : []),
    "Local files were not changed. This verified result requires manual reconciliation.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Download a remote result for review, leaving the local worktree untouched. */
export function detachPullCommand(handoffId: string) {
  return Effect.gen(function* () {
    const pull = yield* Effect.tryPromise(() => pullDetachedTransfer(handoffId));
    process.stdout.write(formatDetachPull(pull));
    if (pull.conflicts.length > 0) process.exitCode = 2;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`Could not download detached result: ${String(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

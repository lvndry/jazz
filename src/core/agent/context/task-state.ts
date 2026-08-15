import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { getWorkStateDirectory } from "@/core/utils/paths";

/**
 * Where the agent is in the current task, as the agent understands it.
 *
 * Distinct from memory, which holds what stays true about a person or project across
 * conversations. This holds what is true about *one task right now* — and is discarded
 * when that task ends. The journal records what happened; this records intent, which
 * only the agent knows and only while it still has it in context.
 *
 * JSON rather than prose because it is edited repeatedly and models patch structured
 * documents far more reliably than they rewrite paragraphs.
 */

const TASK_STATE_FILENAME = "state.json";

/**
 * Work items stay unverified until something has actually been run.
 *
 * Agents habitually mark work complete on the strength of having written it, which turns
 * a progress record into a confident lie. `done` therefore means "verified by running
 * something", not "I believe I finished it".
 */
export type WorkItemStatus = "pending" | "in_progress" | "unverified" | "done" | "failing";

export interface WorkItem {
  readonly description: string;
  readonly status: WorkItemStatus;
  /** What was run to verify it, when status is `done`. */
  readonly verifiedBy?: string | undefined;
}

export interface TaskState {
  readonly goal?: string;
  readonly constraints?: readonly string[];
  /** Choices made and why, so a successor does not relitigate them. */
  readonly decisions?: readonly string[];
  readonly workItems?: readonly WorkItem[];
  readonly filesTouched?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly nextStep?: string;
  readonly updatedAt?: string;
}

export function taskStatePath(agentId: string, conversationId: string): string {
  return path.join(getWorkStateDirectory(agentId, conversationId), TASK_STATE_FILENAME);
}

/** Read current state, or `undefined` when none has been written or it is unreadable. */
export function readTaskState(
  agentId: string,
  conversationId: string,
): Effect.Effect<TaskState | undefined, never, never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(taskStatePath(agentId, conversationId), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((contents) => {
      try {
        const parsed: unknown = JSON.parse(contents);
        return typeof parsed === "object" && parsed !== null ? parsed : undefined;
      } catch {
        return undefined;
      }
    }),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}

/**
 * Merge a patch into the stored state, field by field.
 *
 * Patching rather than replacing: an agent updating `nextStep` must not silently drop
 * the decisions and open questions it did not mention. Only keys present in the patch
 * are touched.
 */
export function patchTaskState(
  agentId: string,
  conversationId: string,
  patch: Partial<TaskState>,
  updatedAt: string,
): Effect.Effect<TaskState, never, never> {
  return readTaskState(agentId, conversationId).pipe(
    Effect.flatMap((existing) => {
      const merged: TaskState = { ...(existing ?? {}), ...patch, updatedAt };
      return Effect.tryPromise({
        try: async () => {
          const directory = getWorkStateDirectory(agentId, conversationId);
          await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
          await nodeFs.writeFile(
            taskStatePath(agentId, conversationId),
            `${JSON.stringify(merged, null, 2)}\n`,
            "utf-8",
          );
          return merged;
        },
        catch: (error) => error,
      }).pipe(Effect.catchAll(() => Effect.succeed(merged)));
    }),
  );
}

/** Render state for a prompt or a CLI view. Returns `undefined` when there is nothing to show. */
export function formatTaskState(state: TaskState | undefined): string | undefined {
  if (!state) return undefined;
  const sections: string[] = [];

  if (state.goal) sections.push(`**Goal:** ${state.goal}`);
  if (state.constraints?.length) {
    sections.push(`**Constraints:**\n${state.constraints.map((item) => `- ${item}`).join("\n")}`);
  }
  if (state.decisions?.length) {
    sections.push(`**Decisions:**\n${state.decisions.map((item) => `- ${item}`).join("\n")}`);
  }
  if (state.workItems?.length) {
    const items = state.workItems
      .map((item) => {
        const verified = item.verifiedBy ? ` (verified by: ${item.verifiedBy})` : "";
        return `- [${item.status}] ${item.description}${verified}`;
      })
      .join("\n");
    sections.push(`**Work items:**\n${items}`);
  }
  if (state.filesTouched?.length) {
    sections.push(`**Files touched:** ${state.filesTouched.join(", ")}`);
  }
  if (state.openQuestions?.length) {
    sections.push(
      `**Open questions:**\n${state.openQuestions.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (state.nextStep) sections.push(`**Next step:** ${state.nextStep}`);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

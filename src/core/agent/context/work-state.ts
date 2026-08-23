import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { getWorkStateDirectory } from "@/core/utils/paths";

/**
 * @fileoverview What the agent is trying to do, as the agent understands it.
 *
 * The agent's own account of the work in front of it: the goal, what it must not break,
 * what it has already decided, and what it means to do next. Written by the model through
 * `update_work_state`, scoped to one conversation, and discarded when that work ends.
 *
 * Three neighbours are easy to confuse with this one, and the difference is who writes it
 * and how long it lasts:
 *
 * - **Memory** (`~/.jazz/memory`) is what stays true about a person or project *between*
 *   conversations. Work state is what is true inside one, right now.
 * - **The work journal** (`./work-journal.ts`) records what *happened*, append-only, as it
 *   happens. Work state records *intent*, which only the agent knows and only while it
 *   still holds it in context — so it is the half that a compaction would otherwise lose.
 * - **A run** (`../run/run-state.ts`) is the runtime's record of one execution: alive,
 *   blocked, finished. That is a fact about a process. This is a belief about a task, and
 *   the two can legitimately disagree — a model can plan its next step while the run it
 *   was planning inside has already been parked waiting for an approval.
 *
 * Stored as JSON rather than prose because it is edited repeatedly, and models patch
 * structured documents far more reliably than they rewrite paragraphs.
 *
 * The list of work itself is deliberately absent. It lives in todos
 * (`../tools/todo-tools.ts`), which are the same thing rendered in the interface — keeping
 * a second list here left the model to guess which one to update.
 */

const WORK_STATE_FILENAME = "state.json";

/**
 * One conversation's working notes.
 *
 * Every field is optional: the model fills in what it knows, and a state with only a goal
 * is more useful than none. `updatedAt` is stamped on write so a successor can tell fresh
 * intent from a stale plan.
 */
export interface WorkState {
  /** What this work is ultimately trying to achieve. */
  readonly goal?: string;
  /** Requirements or limits that must hold, e.g. "must not change the public API". */
  readonly constraints?: readonly string[];
  /** Choices made and why, so a successor does not relitigate them. */
  readonly decisions?: readonly string[];
  /** Paths created or modified so far. */
  readonly filesTouched?: readonly string[];
  /** Unresolved uncertainties, so they survive a compaction instead of being rediscovered. */
  readonly openQuestions?: readonly string[];
  /** The single next action the agent intends to take. */
  readonly nextStep?: string;
  readonly updatedAt?: string;
}

export function workStatePath(agentId: string, conversationId: string): string {
  return path.join(getWorkStateDirectory(agentId, conversationId), WORK_STATE_FILENAME);
}

/** Read current state, or `undefined` when none has been written or it is unreadable. */
export function readWorkState(
  agentId: string,
  conversationId: string,
): Effect.Effect<WorkState | undefined, never, never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(workStatePath(agentId, conversationId), "utf-8"),
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
export function patchWorkState(
  agentId: string,
  conversationId: string,
  patch: Partial<WorkState>,
  updatedAt: string,
): Effect.Effect<WorkState, never, never> {
  return readWorkState(agentId, conversationId).pipe(
    Effect.flatMap((existing) => {
      const merged: WorkState = { ...(existing ?? {}), ...patch, updatedAt };
      return Effect.tryPromise({
        try: async () => {
          const directory = getWorkStateDirectory(agentId, conversationId);
          await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
          await nodeFs.writeFile(
            workStatePath(agentId, conversationId),
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
export function formatWorkState(state: WorkState | undefined): string | undefined {
  if (!state) return undefined;
  const sections: string[] = [];

  if (state.goal) sections.push(`**Goal:** ${state.goal}`);
  if (state.constraints?.length) {
    sections.push(`**Constraints:**\n${state.constraints.map((item) => `- ${item}`).join("\n")}`);
  }
  if (state.decisions?.length) {
    sections.push(`**Decisions:**\n${state.decisions.map((item) => `- ${item}`).join("\n")}`);
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

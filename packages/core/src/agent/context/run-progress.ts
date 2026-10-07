/**
 * Run progress extracted from a conversation's *recent* messages, injected into the
 * post-compaction message.
 *
 * Compaction rewrites the history underneath the model, and the state it uses to know
 * what it has already covered — which files it read, which it modified, what it was
 * doing last — dies with the summarized messages. Without this, a run that compacts
 * mid-pass "realizes" it has covered nothing and re-reads everything it just read,
 * burning the rest of its iteration budget on repetition.
 *
 * The extraction is mechanical (no LLM call) and deliberately keys on the data the
 * tool calls already contain rather than on a curated list of tool names: any tool
 * call whose arguments carry a path-like field is tracked, so a new built-in tool or
 * a plugin tool is covered the moment it exists. Two judgments are still made:
 *
 * - **success** — a call counts as "covered" only if its result (when present) does
 *   not start with the harness's error prefix. A failed read is not a read; the model
 *   is allowed (and should) retry it.
 * - **write vs read** — `write_file`/`edit_file`/`mv`/`cp`/`rm`/`mkdir` take a path
 *   the same way a reader does, so they are listed under "modified" instead. This is
 *   the only name knowledge in the module, and an unlisted writer degrades gracefully
 *   to "read/inspected" rather than disappearing.
 *
 * It only sees the messages kept verbatim after a compaction split; what the
 * summarized middle covered is the checkpoint's "Covered So Far" section's job
 * (see `summarizer.ts`).
 */

import type { ChatMessage } from "@/core/types/message";

/**
 * Path-taking tools that *mutate* their path rather than observe it. Everything else
 * that succeeded and carries a path is reported as read/inspected.
 */
const MUTATING_PATH_TOOLS = new Set(["write_file", "edit_file", "mv", "cp", "rm", "mkdir"]);

/** Argument names that identify a file or directory for a path-taking tool. */
const PATH_ARG_KEYS = new Set(["path", "source"]);

/** Keys on the same pattern the harness uses for directory-scoped tools (find, grep). */
function isPathKey(key: string): boolean {
  return PATH_ARG_KEYS.has(key) || key.endsWith("_path");
}

/** The harness's convention for failed tool results (see tool-result delivery). */
function isErrorResult(content: string | null | undefined): boolean {
  return typeof content === "string" && content.startsWith("error:");
}

const MAX_LISTED_PATHS = 15;

/** A run's working state as the recent messages show it. */
export interface RunProgress {
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
  /** The most recent tool call, e.g. `grep({"pattern": "docker", ...})`. */
  readonly lastAction: string | undefined;
  /** Renders as a short block for the post-compaction message; "" when nothing is tracked. */
  readonly summary: string;
}

function parsedArguments(rawArguments: string | undefined): Record<string, unknown> | undefined {
  if (!rawArguments) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Path-like string arguments of a tool call, in key order. */
function pathsOf(call: { function: { name: string; arguments?: string } }): string[] {
  const args = parsedArguments(call.function.arguments);
  if (!args) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (isPathKey(key) && typeof value === "string" && value.trim() !== "") {
      paths.push(value);
    }
  }
  return paths;
}

/** Maps each tool call id in the window to whether its result came back successfully. */
function callOutcomes(messages: readonly ChatMessage[]): Map<string, boolean> {
  const outcomes = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    if (!outcomes.has(message.tool_call_id)) {
      outcomes.set(message.tool_call_id, !isErrorResult(message.content));
    }
  }
  return outcomes;
}

/**
 * Collect the paths a run already handled, in order first seen, deduplicated.
 * `mode` selects the side: "read" keeps non-mutating calls (a path read_file looked
 * at), "write" keeps mutating ones (a path write_file/edit_file/mv/cp/rm/mkdir changed).
 */
function collectPaths(
  messages: readonly ChatMessage[],
  outcomes: ReadonlyMap<string, boolean>,
  mode: "read" | "write",
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      // A missing result (the split dropped it) is not a failure; only an error result is.
      if (outcomes.get(call.id) === false) continue;
      const isMutating = MUTATING_PATH_TOOLS.has(call.function.name);
      if (mode === "read" ? isMutating : !isMutating) continue;
      for (const path of pathsOf(call)) {
        if (seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * Extract a run's working state from the messages a compaction kept verbatim.
 * Empty when the window contains no successful path-bearing tool calls and no commands.
 */
export function extractRunProgress(messages: readonly ChatMessage[]): RunProgress {
  const outcomes = callOutcomes(messages);
  const filesRead = collectPaths(messages, outcomes, "read");
  const filesModified = collectPaths(messages, outcomes, "write");
  const commandTargets = messages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => call.function.name === "execute_command")
      .map((call) => {
        const args = parsedArguments(call.function.arguments);
        const command = args?.["command"];
        return typeof command === "string" ? command : undefined;
      })
      .filter((command): command is string => command !== undefined)
      .map((command) => command.slice(0, 80)),
  );

  let lastAction: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = messages[i]?.tool_calls;
    if (!calls || calls.length === 0) continue;
    const call = calls[calls.length - 1];
    if (!call) continue;
    const args = call.function.arguments?.trim() ?? "";
    lastAction = `${call.function.name}(${args.length > 80 ? `${args.slice(0, 80)}…` : args})`;
    break;
  }

  if (filesRead.length === 0 && filesModified.length === 0 && commandTargets.length === 0) {
    return { filesRead, filesModified, lastAction, summary: "" };
  }

  const list = (paths: readonly string[], omitted: number): string =>
    `${paths.slice(0, MAX_LISTED_PATHS).join(", ")}${omitted > 0 ? ` +${omitted} more` : ""}`;

  const lines: string[] = ["Work already done since the last compaction — do not redo it:"];
  if (filesRead.length > 0) {
    lines.push(`- Files read/inspected: ${list(filesRead, filesRead.length - MAX_LISTED_PATHS)}`);
  }
  if (filesModified.length > 0) {
    lines.push(`- Files modified: ${list(filesModified, filesModified.length - MAX_LISTED_PATHS)}`);
  }
  if (commandTargets.length > 0) {
    const shown = commandTargets.slice(0, MAX_LISTED_PATHS).join(" | ");
    const more = commandTargets.length - MAX_LISTED_PATHS;
    lines.push(`- Commands run: ${shown}${more > 0 ? ` | +${more} more` : ""}`);
  }
  if (lastAction) lines.push(`- Most recent action: ${lastAction}`);

  return { filesRead, filesModified, lastAction, summary: lines.join("\n") };
}

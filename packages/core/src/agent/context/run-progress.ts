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
 * The extraction is mechanical (no LLM call): tool call arguments are structured, so
 * the paths and targets are already there. It only sees the messages kept verbatim
 * after a compaction split; what the summarized middle covered is the checkpoint's
 * "Covered So Far" section's job (see `summarizer.ts`).
 */

import type { ChatMessage } from "@/core/types/message";

/** Tool names whose first argument identifies a file or directory. */
const READ_TOOLS = new Set([
  "read_file",
  "ls",
  "stat",
  "grep",
  "find",
  "glob",
  "view_memory",
  "view_scratchpad",
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "execute_command",
]);

const MAX_LISTED_PATHS = 15;

/** A run's working state as the recent messages show it. */
export interface RunProgress {
  readonly filesRead: readonly string[];
  readonly filesModified: readonly string[];
  /** The most recent non-read tool call, e.g. `grep({"pattern": "docker", ...})`. */
  readonly lastAction: string | undefined;
  /** Renders as a short block for the post-compaction message; "" when nothing is tracked. */
  readonly summary: string;
}

function argumentValue(rawArguments: string | undefined, key: string): string | undefined {
  if (!rawArguments) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function collectPaths(
  messages: readonly ChatMessage[],
  tools: ReadonlySet<string>,
  argumentKeys: readonly string[],
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined) => {
    if (path === undefined || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function.name;
      if (!tools.has(name)) continue;
      for (const key of argumentKeys) {
        add(argumentValue(call.function.arguments, key));
      }
    }
  }
  return paths;
}

/**
 * Extract a run's working state from the messages a compaction kept verbatim.
 * Empty when the window contains no file-bearing tool calls.
 */
export function extractRunProgress(messages: readonly ChatMessage[]): RunProgress {
  const filesRead = collectPaths(messages, READ_TOOLS, ["path"]);
  const filesModified = collectPaths(messages, WRITE_TOOLS, ["path", "source"]);
  const commandTargets = messages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => call.function.name === "execute_command")
      .map((call) => argumentValue(call.function.arguments, "command"))
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

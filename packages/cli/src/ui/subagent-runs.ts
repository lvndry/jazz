/**
 * What the UI knows about each delegated sub-agent: who it is, what it was asked,
 * everything it has done so far, and any messages the user has addressed to it.
 *
 * An ephemeral region only keeps a short tail for its live panel and is gone the
 * moment it collapses. A run keeps the whole feed and survives its collapse, so the
 * user can open a sub-agent that already finished and read what it did.
 */

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted";

/**
 * Where a piece of a sub-agent's streamed text came from. The region tail flattens
 * everything into lines; the run keeps them apart so a detail view can style
 * thinking and prose differently. `tail` text is only for the live panel: a tool
 * call's one-line rendering or a status line, which the run already has in
 * structured form, so storing it would show everything twice.
 */
export type SubagentChannel = "reasoning" | "response" | "note" | "tail";

export interface SubagentTextEntry {
  readonly kind: "reasoning" | "response" | "note" | "steer";
  readonly text: string;
}

export interface SubagentToolEntry {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly args: string;
  readonly status: "running" | "ok" | "failed";
  readonly summary?: string;
  readonly durationMs?: number;
}

export type SubagentEntry = SubagentTextEntry | SubagentToolEntry;

export interface SubagentRun {
  readonly id: string;
  readonly label: string;
  /** The full brief the parent wrote. */
  readonly task: string;
  /** False for a run with no step boundary at which a message could reach it. */
  readonly acceptsMessages: boolean;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: SubagentStatus;
  readonly entries: readonly SubagentEntry[];
  /** Newest non-blank line of output, for the one-row list summary. */
  readonly activity: string;
  /** Messages the user sent that the sub-agent's loop has not picked up yet. */
  readonly pendingMessages: readonly string[];
}

/**
 * Oldest entries are dropped past this. A tool call or a streamed paragraph is one
 * entry, and a sub-agent's iteration budget rarely produces more than a few hundred;
 * the cap exists for the run that loops on a noisy tool.
 */
export const MAX_SUBAGENT_ENTRIES = 1000;

export function openSubagentRun(
  id: string,
  label: string,
  startedAt: number,
  agentRun: { readonly task: string; readonly acceptsMessages: boolean },
): SubagentRun {
  return {
    id,
    label,
    task: agentRun.task,
    acceptsMessages: agentRun.acceptsMessages,
    startedAt,
    status: "running",
    entries: [],
    activity: "",
    pendingMessages: [],
  };
}

/** A code fence's opening or closing line says nothing about what the agent is doing. */
const FENCE_LINE = /^(`{3,}|~{3,})[\w-]*$/;

/**
 * The newest line worth showing as a one-row summary: not blank, not a bare fence.
 *
 * Walks back from the end rather than splitting, because this runs on every streamed
 * piece of an entry that keeps growing: splitting the whole entry each time would make
 * a long answer quadratic to stream.
 */
function lastNonBlankLine(text: string): string | undefined {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end).trim();
    if (line.length > 0 && !FENCE_LINE.test(line)) return line;
    end = start - 1;
  }
  return undefined;
}

function withEntry(run: SubagentRun, entry: SubagentEntry, activity: string): SubagentRun {
  const entries = [...run.entries, entry];
  return {
    ...run,
    activity,
    entries:
      entries.length > MAX_SUBAGENT_ENTRIES
        ? entries.slice(entries.length - MAX_SUBAGENT_ENTRIES)
        : entries,
  };
}

/**
 * Reasoning and prose arrive in token-sized pieces and are merged into the entry
 * they continue; a change of channel starts a new entry.
 */
export function appendToSubagentRun(
  run: SubagentRun,
  text: string,
  channel: SubagentChannel,
): SubagentRun {
  if (text.length === 0) return run;
  if (channel === "tail") return { ...run, activity: lastNonBlankLine(text) ?? run.activity };
  // A metrics note closes a step; the step's own last line is still the better summary.
  const summarizes = channel !== "note";

  const last = run.entries.at(-1);
  if (last?.kind === channel) {
    const merged = last.text + text;
    return {
      ...run,
      activity: (summarizes ? lastNonBlankLine(merged) : undefined) ?? run.activity,
      entries: [...run.entries.slice(0, -1), { kind: channel, text: merged }],
    };
  }
  const opening = text.replace(/^\n+/, "");
  if (opening.length === 0) return run;
  return withEntry(
    run,
    { kind: channel, text: opening },
    (summarizes ? lastNonBlankLine(opening) : undefined) ?? run.activity,
  );
}

export function startSubagentTool(
  run: SubagentRun,
  tool: { readonly toolCallId: string; readonly name: string; readonly args: string },
): SubagentRun {
  const activity = tool.args.length > 0 ? `${tool.name} ${tool.args}` : tool.name;
  return withEntry(run, { kind: "tool", ...tool, status: "running" }, activity);
}

export function finishSubagentTool(
  run: SubagentRun,
  toolCallId: string,
  outcome: { readonly failed: boolean; readonly summary: string; readonly durationMs: number },
): SubagentRun {
  let found = false;
  const entries = run.entries.map((entry) => {
    if (entry.kind !== "tool" || entry.toolCallId !== toolCallId) return entry;
    found = true;
    return {
      ...entry,
      status: outcome.failed ? ("failed" as const) : ("ok" as const),
      summary: outcome.summary,
      durationMs: outcome.durationMs,
    };
  });
  if (!found) return run;
  return { ...run, entries, activity: outcome.summary.length > 0 ? outcome.summary : run.activity };
}

export function finishSubagentRun(
  run: SubagentRun,
  status: Exclude<SubagentStatus, "running">,
  endedAt: number,
): SubagentRun {
  if (run.status !== "running") return run;
  return { ...run, status, endedAt, pendingMessages: [] };
}

/** A message can only reach a sub-agent whose loop is still going and polls for one. */
export function steerSubagentRun(run: SubagentRun, message: string): SubagentRun | null {
  const text = message.trim();
  if (!run.acceptsMessages || run.status !== "running" || text.length === 0) return null;
  return withEntry(
    { ...run, pendingMessages: [...run.pendingMessages, text] },
    { kind: "steer", text },
    run.activity,
  );
}

export function takeSubagentMessages(run: SubagentRun): {
  readonly run: SubagentRun;
  readonly message: string | undefined;
} {
  if (run.pendingMessages.length === 0) return { run, message: undefined };
  return {
    run: { ...run, pendingMessages: [] },
    message: run.pendingMessages.join("\n\n"),
  };
}

export function subagentElapsedMs(run: SubagentRun, now: number): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

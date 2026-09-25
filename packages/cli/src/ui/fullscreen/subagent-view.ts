/**
 * A sub-agent's run, as the transcript blocks that replace the conversation while
 * the user is looking at it. Pure, so the takeover is reproducible from data the way
 * every other frame is.
 */

import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { getGlyphs } from "../glyphs";
import { subagentElapsedMs, type SubagentRun, type SubagentStatus } from "../subagent-runs";
import { formatElapsed } from "./LiveZone";
import type { Block, SubagentListItem } from "./types";

const STATUS_WORDS: Readonly<Record<SubagentStatus, string>> = {
  running: "running",
  completed: "done",
  failed: "failed",
  interrupted: "interrupted",
};

export function subagentListItem(run: SubagentRun, now: number): SubagentListItem {
  return {
    id: run.id,
    label: run.label,
    status: run.status,
    activity: stripAnsiCodes(run.activity),
    elapsedMs: subagentElapsedMs(run, now),
  };
}

/**
 * Blocks for one run, top to bottom: a heading that says whose log this is, the
 * brief the parent wrote, then everything the sub-agent did in order. The brief and
 * the user's own messages are both user turns to the sub-agent, so they render as
 * user turns.
 */
export function subagentBlocks(run: SubagentRun, now: number): Block[] {
  const glyphs = getGlyphs();
  const blocks: Block[] = [];
  let seq = 0;
  const heading = [
    run.label,
    STATUS_WORDS[run.status],
    formatElapsed(subagentElapsedMs(run, now)),
  ].join(` ${glyphs.bullet} `);
  blocks.push({ id: `${run.id}:heading`, seq: seq++, kind: "divider", label: heading });

  if (run.task.trim().length > 0) {
    blocks.push({ id: `${run.id}:task`, seq: seq++, kind: "user", text: run.task });
  }

  const lastIndex = run.entries.length - 1;
  run.entries.forEach((entry, index) => {
    const id = `${run.id}:${String(index)}`;
    switch (entry.kind) {
      case "steer":
        blocks.push({ id, seq: seq++, kind: "user", text: entry.text });
        return;
      case "reasoning":
        blocks.push({
          id,
          seq: seq++,
          kind: "reasoning",
          text: stripAnsiCodes(entry.text).trim(),
          collapsed: false,
        });
        return;
      case "response": {
        const markdown = stripAnsiCodes(entry.text);
        if (markdown.trim().length === 0) return;
        blocks.push({
          id,
          seq: seq++,
          kind: "agent",
          markdown,
          ...(index === lastIndex && run.status === "running" ? { streaming: true } : {}),
        });
        return;
      }
      case "note":
        blocks.push({
          id,
          seq: seq++,
          kind: "divider",
          label: stripAnsiCodes(entry.text).trim(),
        });
        return;
      case "tool": {
        const failed = entry.status === "failed";
        const summary = stripAnsiCodes(entry.summary ?? "");
        blocks.push({
          id,
          seq: seq++,
          kind: "tool",
          app: entry.name,
          ...(entry.args.length > 0 ? { args: entry.args } : {}),
          summary: entry.status === "running" ? "running" : failed ? "" : summary,
          status: failed ? "failed" : "ok",
          ...(failed && summary.length > 0 ? { reason: summary } : {}),
          ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        });
        return;
      }
    }
  });
  return blocks;
}

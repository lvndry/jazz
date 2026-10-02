/**
 * The `who_is_here` tool: "is anyone working in this directory right now?"
 *
 * The answer is a read of the shared occupancy file, not a message to other agents. Every
 * jazz process heartbeats an entry (agent, directory, last mutating call) while a run is
 * live; this tool reads them, drops anything that has stopped heartbeating, and bands the
 * survivors. `writing` is the collision-relevant band — an agent mutating within the last
 * two minutes is the one you'd trample by checking out a branch. `wrote-idle` and `reading`
 * are presence without that alarm.
 *
 * Matching is two-stage: path containment first (same directory tree), then shared
 * `git common dir` (same repository, different worktree — the exact "they checked out, now
 * I'm in a worktree" case). Git facts are fetched live for the queried directory and each
 * outside occupant, never stored: a branch moves in an instant and the report must not
 * lie about it.
 */

import { Effect } from "effect";
import { z } from "zod";
import {
  OCCUPANCY_FRESH_WINDOW_MS,
  OCCUPANCY_WRITING_WINDOW_MS,
} from "@/core/agent/run/run-recorder";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { OccupancyServiceTag, type OccupancyService } from "@/core/interfaces/occupancy";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { OccupancyBand, OccupancyEntry, OccupancyOwnerStatus } from "@/core/types/occupancy";
import type { ToolExecutionResult } from "@/core/types/tools";
import { readGitInfo, type GitInfo } from "@/core/utils/git-info";
import { currentProcessOwner, localOwnerStatus } from "@/core/utils/process";
import { defineTool } from "./base-tool";

interface OccupiedDirectory {
  readonly entry: OccupancyEntry;
  readonly band: OccupancyBand;
  readonly owner: OccupancyOwnerStatus;
}

/** True when `dir` and `base` are in the same directory tree, either direction. */
function sameDirectoryTree(dir: string, base: string): boolean {
  if (dir === base) return true;
  const prefixBase = base.endsWith("/") ? base : `${base}/`;
  const prefixDir = dir.endsWith("/") ? dir : `${dir}/`;
  return dir.startsWith(prefixBase) || base.startsWith(prefixDir);
}

function bandOf(entry: OccupancyEntry, now: number): OccupancyBand {
  if (entry.lastMutatingAt !== undefined) {
    const mutatingAge = now - Date.parse(entry.lastMutatingAt);
    if (!Number.isNaN(mutatingAge) && mutatingAge <= OCCUPANCY_WRITING_WINDOW_MS) {
      return "writing";
    }
    return "wrote-idle";
  }
  return "reading";
}

/**
 * Presence: still heartbeating AND the process alive AND the run not already over. A
 * finished run stops heartbeating, but its *final* entry is written by the still-live
 * process, so terminal states drop on their own rather than lingering as fresh
 * "present" entries; a stale entry and a dead pid both drop too.
 */
function isPresent(
  entry: Pick<OccupancyEntry, "state">,
  owner: OccupancyOwnerStatus,
  updatedAt: string,
  now: number,
): boolean {
  if (owner === "gone") return false;
  if (entry.state !== "working" && entry.state !== "input-required") return false;
  const updated = Date.parse(updatedAt);
  return !Number.isNaN(updated) && now - updated <= OCCUPANCY_FRESH_WINDOW_MS;
}

function describeEntry(entry: OccupancyEntry, band: OccupancyBand, now: number): string {
  if (band === "writing") {
    const secs = Math.max(0, Math.round((now - Date.parse(entry.lastMutatingAt as string)) / 1000));
    const parts = [`WRITING here — last write ${secs}s ago`];
    if (entry.lastMutatingTool !== undefined) parts.push(`via ${entry.lastMutatingTool}`);
    if (entry.lastMutatingPath !== undefined) parts.push(`touched ${entry.lastMutatingPath}`);
    else if (entry.lastMutatingTool === "execute_command") {
      parts.push("write target unknown (shell command)");
    }
    return parts.join(" · ");
  }
  if (band === "wrote-idle") return "wrote earlier this run, idle since";
  return "present, reads only";
}

function occupantLine(o: OccupiedDirectory, now: number, indent: string, extra: string): string {
  const marker = o.band === "writing" ? "●" : "○";
  const detail = describeEntry(o.entry, o.band, now);
  const state = o.entry.state === "input-required" ? " · waiting on approval" : "";
  const prompt = o.entry.promptExcerpt !== undefined ? ` · "${o.entry.promptExcerpt}"` : "";
  return `${indent}${marker} agent "${o.entry.agentName}" (${o.entry.runId.slice(0, 8)})${extra} — ${detail}${state}${prompt}`;
}

function buildReport(
  directory: string,
  gitInfo: GitInfo | undefined,
  inTree: readonly OccupiedDirectory[],
  sameRepo: readonly OccupiedDirectory[],
  outside: readonly OccupiedDirectory[],
): string {
  const now = Date.now();
  const lines: string[] = [`who_is_here(${directory}):`];

  if (inTree.length === 0 && sameRepo.length === 0 && outside.length === 0) {
    lines.push("  nobody is working here (no jazz run heartbeating within the last 90s)");
    return lines.join("\n");
  }

  for (const o of inTree) {
    lines.push(occupantLine(o, now, "  ", ""));
  }

  if (sameRepo.length > 0) {
    lines.push("  same repository, other worktree/checkout:");
    for (const o of sameRepo) {
      lines.push(occupantLine(o, now, "    ", ` in ${o.entry.workingDirectory}`));
    }
  }

  if (outside.length > 0) {
    lines.push("  elsewhere on this machine:");
    for (const o of outside) {
      lines.push(occupantLine(o, now, "    ", ` in ${o.entry.workingDirectory}`));
    }
  }

  if (gitInfo !== undefined && inTree.length > 0) {
    lines.push(`  you are on branch ${gitInfo.branch}`);
  }
  return lines.join("\n");
}

/**
 * Create the `who_is_here` tool.
 *
 * Reads the occupancy registry (every jazz process's live heartbeats), filters to what is
 * actually present, and reports occupants of the queried directory, of the same
 * repository in other worktrees, and — for orientation — of elsewhere on the machine.
 * Banding (writing / wrote-idle / reading) is computed from each entry's timestamps at
 * read time.
 */
interface WhoIsHereArgs extends Record<string, unknown> {
  readonly directory?: string;
}

export function createWhoIsHereTool(): Tool<OccupancyService | FileSystemContextService> {
  return defineTool<OccupancyService | FileSystemContextService, WhoIsHereArgs>({
    name: "who_is_here",
    disclosure: "internal",
    description:
      "Check whether any other jazz agent is currently working in a directory. " +
      "Call it before checking out a branch, switching worktrees, or editing in a shared " +
      "repository, to find out who else is here and whether they are writing. " +
      "An agent 'WRITING here' mutated files within the last 2 minutes — collision risk. " +
      "'present, reads only' and 'wrote earlier, idle' are informational. " +
      "Occupants in the same repository but a different worktree/checkout are listed separately.",
    parameters: z
      .object({
        directory: z
          .string()
          .optional()
          .describe("Directory to check. Defaults to the current working directory."),
      })
      .strict(),
    riskLevel: "read-only",
    egress: false,
    hidden: false,
    handler: (args, context) => {
      return Effect.gen(function* () {
        const occupancy = yield* OccupancyServiceTag;
        const fsContext = yield* FileSystemContextServiceTag;

        const cwd =
          args.directory ??
          (yield* fsContext.getCwd({
            agentId: context.agentId,
            ...(context.conversationId !== undefined
              ? { conversationId: context.conversationId }
              : {}),
          }));

        const entries = yield* occupancy.list();
        const now = Date.now();

        const present: OccupiedDirectory[] = [];
        for (const entry of entries) {
          // Drop only this run: a run asking "who is here" does not want its own heartbeat
          // reported back, but a sibling run in the same process (daemon, run + sub-agent)
          // is exactly who the question is about, so it stays. Callers without a runId
          // (older contexts, direct test harnesses) fall back to process-level identity.
          const self =
            context.runId !== undefined
              ? { match: (e: OccupancyEntry) => e.runId === context.runId }
              : (() => {
                  const { pid, host } = currentProcessOwner();
                  return { match: (e: OccupancyEntry) => e.pid === pid && e.host === host };
                })();
          if (self.match(entry)) continue;
          // One process check per entry: it is the presence gate and the reported owner
          // state, and `ps` is a sync spawn, so it is not something to do twice.
          const owner = localOwnerStatus({ pid: entry.pid, host: entry.host });
          if (!isPresent(entry, owner, entry.updatedAt, now)) continue;
          present.push({
            entry,
            band: bandOf(entry, now),
            owner,
          });
        }

        const inTree = present.filter((o) => sameDirectoryTree(o.entry.workingDirectory, cwd));
        const rest = present.filter((o) => !sameDirectoryTree(o.entry.workingDirectory, cwd));
        // Same-repo detection is live: ask git for the common dir of each outside
        // occupant and compare with the queried directory's. A few git calls, one second
        // timeout each, and a directory that is not a repo just sorts to "elsewhere".
        let callerGit: GitInfo | undefined;
        if (rest.length > 0) {
          const [caller, ...restGits] = yield* Effect.all(
            [cwd, ...rest.map((o) => o.entry.workingDirectory)].map((d) =>
              Effect.tryPromise(() => readGitInfo(d)),
            ),
            { discard: false },
          );
          callerGit = caller;
          const sameRepo: OccupiedDirectory[] = [];
          const outside: OccupiedDirectory[] = [];
          rest.forEach((o, i) => {
            if (callerGit !== undefined && restGits[i]?.commonDir === callerGit.commonDir) {
              sameRepo.push(o);
            } else {
              outside.push(o);
            }
          });
          return {
            success: true,
            result: buildReport(cwd, callerGit, inTree, sameRepo, outside),
          } satisfies ToolExecutionResult;
        }

        return {
          success: true,
          result: buildReport(
            cwd,
            yield* Effect.tryPromise(() => readGitInfo(cwd)),
            inTree,
            [],
            [],
          ),
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.mapError((error) => {
          return new Error(
            `Failed to read occupancy: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );
    },
  });
}

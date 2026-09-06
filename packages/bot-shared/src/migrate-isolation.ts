/**
 * @fileoverview Moving an existing shared data directory into per-conversation
 * sandboxes.
 *
 * Before isolation, every conversation's agent, memory, history, workspace and
 * reminders sat side by side in one Jazz home, told apart only by the id prefix
 * each bridge names them with. This walks that layout, gives each conversation
 * the sandbox it now expects, and moves its files in — plus, for the operator's
 * own conversation, the things that were never per-conversation at all: the
 * secrets file and the mail, calendar, GPG and `pass` stores, which belong to
 * whoever set them up.
 *
 * The id scheme is the only bridge-specific part, so it is passed in; each
 * bridge's own `migrate-isolation.ts` is the command-line wrapper around this.
 */

import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { adoptIntoSandbox, type ChatSandbox, ensureChatSandbox } from "./chat-sandbox";

interface Move {
  readonly from: string;
  readonly to: string;
}

/**
 * Everything under the shared home that belongs to exactly one conversation,
 * by the id segment Jazz names it with.
 */
function conversationOwnedPaths(dataDir: string, home: string, agentId: string): Move[] {
  const relatives = [
    join("agents", `${agentId}.json`),
    join("memory", agentId),
    join("history", "conversations", agentId),
    join("history", "conversation-locks", `${agentId}.lock`),
    join("workspace", agentId),
    join("workspace", `${agentId}.lock`),
    join("work", agentId),
    join("reminders", `${agentId}.json`),
  ];
  return relatives
    .filter((relative) => existsSync(join(dataDir, relative)))
    .map((relative) => ({ from: join(dataDir, relative), to: join(home, relative) }));
}

/**
 * State that was shared by every conversation because nothing ever scoped it.
 *
 * These are one person's credentials — the mail account himalaya logs into, the
 * GPG key `pass` unlocks, the API keys in `secrets.json` — so they go to the
 * operator's own conversation rather than staying reachable from all of them.
 */
function operatorOwnedPaths(dataDir: string, home: string): Move[] {
  const names = [
    "secrets.json",
    "xdg-config",
    "xdg-data",
    "xdg-state",
    "gnupg",
    "password-store",
    "webapps",
  ];
  return names
    .filter((name) => existsSync(join(dataDir, name)))
    .map((name) => ({ from: join(dataDir, name), to: join(home, name) }));
}

function isEmptyDirectory(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

/**
 * Hand a moved file or directory, and everything under it, to the
 * conversation's uid, and take the world bits off.
 *
 * A rename keeps the source's mode, and everything written before isolation was
 * created under a 022 umask — so without the second half, migrated transcripts
 * and mail configs would arrive in their new home still readable to every
 * account on the box.
 */
function adoptTree(sandbox: ChatSandbox, path: string, setMode: SetMode): void {
  adoptIntoSandbox(sandbox, path);
  const stats = statSync(path);
  const mode = stats.mode & 0o7777;
  if ((mode & 0o007) !== 0) setMode(path, mode & ~0o007);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    adoptTree(sandbox, join(path, entry), setMode);
  }
}

type SetMode = (path: string, mode: number) => void;

/** Every conversation this bridge has state for in the shared home. */
export function conversationsWithState(
  dataDir: string,
  isConversationAgentId: (agentId: string) => boolean,
): string[] {
  const agentsDirectory = join(dataDir, "agents");
  if (!existsSync(agentsDirectory)) return [];
  return readdirSync(agentsDirectory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter(isConversationAgentId);
}

export interface MigrationOptions {
  readonly dataDir: string;
  readonly agentIds: readonly string[];
  /** The conversation that inherits the stores nothing ever scoped. */
  readonly operatorAgentId: string;
  /** Print the plan without touching anything. */
  readonly apply: boolean;
  readonly setMode: SetMode;
}

/** @returns How many paths were moved (zero on a dry run). */
export function migrateToSandboxes(options: MigrationOptions): number {
  const agentIds = options.agentIds.includes(options.operatorAgentId)
    ? [...options.agentIds]
    : [...options.agentIds, options.operatorAgentId];

  let moved = 0;
  for (const agentId of agentIds) {
    const sandbox = ensureChatSandbox(options.dataDir, agentId);
    const moves = [
      ...conversationOwnedPaths(options.dataDir, sandbox.home, agentId),
      ...(agentId === options.operatorAgentId
        ? operatorOwnedPaths(options.dataDir, sandbox.home)
        : []),
    ];
    console.log(
      `${agentId} → ${sandbox.home} (uid ${String(sandbox.uid)}), ${String(moves.length)} path(s)`,
    );
    for (const move of moves) {
      if (existsSync(move.to)) {
        // Creating the sandbox seeds empty `gnupg`, `password-store` and
        // `xdg-*` directories, so without this every one of the operator's real
        // mail and calendar credentials would be reported as already there and
        // silently left behind in the shared home.
        if (!isEmptyDirectory(move.to)) {
          console.log(`  skip ${move.from} — ${move.to} already has content`);
          continue;
        }
        console.log(`  ${options.apply ? "replace" : "would replace"} empty ${move.to}`);
        if (options.apply) rmdirSync(move.to);
      }
      console.log(`  ${options.apply ? "move" : "would move"} ${move.from} → ${move.to}`);
      if (!options.apply) continue;
      renameSync(move.from, move.to);
      adoptTree(sandbox, move.to, options.setMode);
      moved += 1;
    }
  }
  return moved;
}

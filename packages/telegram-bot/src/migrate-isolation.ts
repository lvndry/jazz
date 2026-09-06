/**
 * @fileoverview One-off move of an existing shared data directory into
 * per-chat sandboxes.
 *
 * Before per-chat isolation every chat's agent, memory, history, workspace and
 * reminders sat side by side in one Jazz home, told apart only by a `tg_<chat
 * id>` prefix. This walks that layout, gives each chat the sandbox it now
 * expects, and moves its files in — plus, for the operator's own chat, the
 * things that were never per-chat at all: the secrets file and the mail,
 * calendar, GPG and `pass` stores, which belong to whoever set them up.
 *
 * Prints what it would do and changes nothing until `--apply` is passed.
 *
 * Usage:
 *   bun migrate-isolation.ts --operator <chat id> [--apply]
 */

import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  adoptIntoSandbox,
  chatIsolationEnabled,
  ensureChatSandbox,
  setMode,
} from "@jazz/bot-shared/chat-sandbox";
import { agentIdForChat, isChatAgentId } from "./agents";

interface Move {
  readonly from: string;
  readonly to: string;
}

/**
 * Everything under the shared home that belongs to exactly one chat, by the
 * `tg_<chat id>` segment Jazz names it with.
 */
function chatOwnedPaths(dataDir: string, home: string, agentId: string): Move[] {
  const candidates: [string, string][] = [
    [join("agents", `${agentId}.json`), join("agents", `${agentId}.json`)],
    [join("memory", agentId), join("memory", agentId)],
    [join("history", "conversations", agentId), join("history", "conversations", agentId)],
    [
      join("history", "conversation-locks", `${agentId}.lock`),
      join("history", "conversation-locks", `${agentId}.lock`),
    ],
    [join("workspace", agentId), join("workspace", agentId)],
    [join("workspace", `${agentId}.lock`), join("workspace", `${agentId}.lock`)],
    [join("work", agentId), join("work", agentId)],
    [join("reminders", `${agentId}.json`), join("reminders", `${agentId}.json`)],
  ];
  return candidates
    .filter(([relative]) => existsSync(join(dataDir, relative)))
    .map(([relative, target]) => ({ from: join(dataDir, relative), to: join(home, target) }));
}

/**
 * State that was shared by every chat because nothing ever scoped it.
 *
 * These are one person's credentials — the mail account himalaya logs into,
 * the GPG key `pass` unlocks, the API keys in `secrets.json` — so they go to
 * the operator's own chat rather than staying reachable from all of them.
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

function chatIdsWithState(dataDir: string): number[] {
  const agentsDirectory = join(dataDir, "agents");
  if (!existsSync(agentsDirectory)) return [];
  const ids: number[] = [];
  for (const entry of readdirSync(agentsDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const agentId = entry.slice(0, -".json".length);
    if (!isChatAgentId(agentId)) continue;
    const suffix = agentId.slice("tg_".length);
    const parsed = Number.parseInt(suffix.startsWith("n") ? `-${suffix.slice(1)}` : suffix, 10);
    if (Number.isFinite(parsed)) ids.push(parsed);
  }
  return ids;
}

function parseArguments(argv: string[]): { operator: number | null; apply: boolean } {
  const operatorIndex = argv.indexOf("--operator");
  const raw = operatorIndex === -1 ? undefined : argv[operatorIndex + 1];
  const operator = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return {
    operator: Number.isFinite(operator) ? operator : null,
    apply: argv.includes("--apply"),
  };
}

function main(): void {
  const dataDir = process.env["JAZZ_HOME"]?.trim() || "/data";
  const { operator, apply } = parseArguments(process.argv.slice(2));

  if (!chatIsolationEnabled()) {
    console.error(
      "Per-chat isolation is not active in this process (needs root, setpriv and useradd, and JAZZ_BOT_CHAT_ISOLATION not set to 0). Nothing to migrate into.",
    );
    process.exit(1);
  }
  if (operator === null) {
    console.error(
      "Pass --operator <chat id>: the chat that inherits the shared secrets, mail, calendar, GPG and pass stores.",
    );
    process.exit(1);
  }

  const chatIds = chatIdsWithState(dataDir);
  if (!chatIds.includes(operator)) chatIds.push(operator);

  let moved = 0;
  for (const chatId of chatIds) {
    const agentId = agentIdForChat(chatId);
    const sandbox = ensureChatSandbox(dataDir, agentId);
    const moves = [
      ...chatOwnedPaths(dataDir, sandbox.home, agentId),
      ...(chatId === operator ? operatorOwnedPaths(dataDir, sandbox.home) : []),
    ];
    console.log(
      `${agentId} → ${sandbox.home} (uid ${String(sandbox.uid)}), ${String(moves.length)} path(s)`,
    );
    for (const move of moves) {
      if (existsSync(move.to)) {
        // Creating the sandbox seeds empty `gnupg`, `password-store` and
        // `xdg-*` directories, so without this every one of the operator's
        // real mail and calendar credentials would be reported as already
        // there and silently left behind in the shared home.
        if (!isEmptyDirectory(move.to)) {
          console.log(`  skip ${move.from} — ${move.to} already has content`);
          continue;
        }
        console.log(`  ${apply ? "replace" : "would replace"} empty ${move.to}`);
        if (apply) rmdirSync(move.to);
      }
      console.log(`  ${apply ? "move" : "would move"} ${move.from} → ${move.to}`);
      if (!apply) continue;
      renameSync(move.from, move.to);
      adoptTree(sandbox, move.to);
      moved += 1;
    }
  }

  console.log(
    apply
      ? `Moved ${String(moved)} path(s). Restart the bridge.`
      : "Dry run — nothing changed. Re-run with --apply.",
  );
}

function isEmptyDirectory(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

/**
 * Hand a moved file or directory, and everything under it, to the chat's uid,
 * and take the world bits off.
 *
 * A rename keeps the source's mode, and everything written before this change
 * was created under a 022 umask — so without the second half, migrated
 * transcripts and mail configs would arrive in their new home still readable
 * to every account on the box.
 */
function adoptTree(sandbox: Parameters<typeof adoptIntoSandbox>[0], path: string): void {
  adoptIntoSandbox(sandbox, path);
  const stats = statSync(path);
  const mode = stats.mode & 0o7777;
  if ((mode & 0o007) !== 0) setMode(path, mode & ~0o007);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    adoptTree(sandbox, join(path, entry));
  }
}

main();

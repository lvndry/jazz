/**
 * @fileoverview Open a shell (or run one command) inside a chat's sandbox.
 *
 * Setting up mail, a calendar or a `pass` store is an interactive job done
 * through `docker compose exec`, and with per-chat sandboxes those stores live
 * under one chat's home and are owned by one chat's uid. A root shell would
 * create them owned by root, where the agent that needs them cannot read them,
 * so setup goes through here instead.
 *
 * Usage:
 *   bun chat-shell.ts <chat id> [command …]      # defaults to an interactive bash
 */

import { ensureChatSandbox, sandboxCommand, sandboxEnv } from "@jazz/bot-shared/chat-sandbox";
import { agentIdForChat } from "./agents";

const [chatIdRaw, ...command] = process.argv.slice(2);
const chatId = Number.parseInt(chatIdRaw ?? "", 10);
if (!Number.isFinite(chatId)) {
  console.error("Usage: bun chat-shell.ts <chat id> [command …]");
  process.exit(1);
}

const dataDir = process.env["JAZZ_HOME"]?.trim() || "/data";
const sandbox = ensureChatSandbox(dataDir, agentIdForChat(chatId));
const target = command.length > 0 ? command : ["bash", "-l"];

console.error(
  sandbox.isolated
    ? `${agentIdForChat(chatId)} → ${sandbox.home} as uid ${String(sandbox.uid)}`
    : `Per-chat isolation is off; running in the shared home ${sandbox.home} as the current user.`,
);

const child = Bun.spawn(sandboxCommand(sandbox, target), {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: sandboxEnv(sandbox, process.env),
});
process.exit(await child.exited);

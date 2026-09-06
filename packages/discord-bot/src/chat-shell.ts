/**
 * @fileoverview Open a shell (or run one command) inside a conversation's sandbox.
 *
 * Setting up mail, a calendar or a `pass` store is an interactive job done
 * through `docker compose exec`, and with per-conversation sandboxes those
 * stores live under one channel's home and are owned by one channel's uid. A
 * root shell would create them owned by root, where the agent that needs them
 * cannot read them, so setup goes through here instead.
 *
 * Usage:
 *   bun chat-shell.ts <channel id> [command …]      # defaults to an interactive bash
 */

import { ensureChatSandbox, sandboxCommand, sandboxEnv } from "@jazz/bot-shared/chat-sandbox";
import { agentIdForChannel } from "./agents";

const [channelId, ...command] = process.argv.slice(2);
if (channelId === undefined || !/^\d{17,20}$/.test(channelId)) {
  console.error("Usage: bun chat-shell.ts <channel id> [command …]");
  process.exit(1);
}

const dataDir = process.env["JAZZ_HOME"]?.trim() || "/data";
const sandbox = ensureChatSandbox(dataDir, agentIdForChannel(channelId));
const target = command.length > 0 ? command : ["bash", "-l"];

console.error(
  sandbox.isolated
    ? `${agentIdForChannel(channelId)} → ${sandbox.home} as uid ${String(sandbox.uid)}`
    : `Per-conversation isolation is off; running in the shared home ${sandbox.home} as the current user.`,
);

const child = Bun.spawn(sandboxCommand(sandbox, target), {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: sandboxEnv(sandbox, process.env),
});
process.exit(await child.exited);

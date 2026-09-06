/**
 * @fileoverview One-off move of an existing shared data directory into
 * per-conversation sandboxes. The work is shared with the Telegram bridge;
 * this only supplies Discord's id scheme and command line.
 *
 * Prints what it would do and changes nothing until `--apply`.
 *
 * Usage:
 *   bun migrate-isolation.ts --operator <channel id> [--apply]
 */

import { chatIsolationEnabled, setMode } from "@jazz/bot-shared/chat-sandbox";
import { conversationsWithState, migrateToSandboxes } from "@jazz/bot-shared/migrate-isolation";
import { agentIdForChannel, channelIdFromAgentId } from "./agents";

const argv = process.argv.slice(2);
const operatorIndex = argv.indexOf("--operator");
const operatorChannelId = operatorIndex === -1 ? "" : (argv[operatorIndex + 1] ?? "");
const apply = argv.includes("--apply");
const dataDir = process.env["JAZZ_HOME"]?.trim() || "/data";

if (!chatIsolationEnabled()) {
  console.error(
    "Per-conversation isolation is not active in this process (needs root, setpriv and useradd, and JAZZ_BOT_CHAT_ISOLATION not set to 0). Nothing to migrate into.",
  );
  process.exit(1);
}
if (!/^\d{17,20}$/.test(operatorChannelId)) {
  console.error(
    "Pass --operator <channel id>: the conversation that inherits the shared secrets, mail, calendar, GPG and pass stores. Use the DM or thread you set them up from.",
  );
  process.exit(1);
}

const moved = migrateToSandboxes({
  dataDir,
  agentIds: conversationsWithState(dataDir, (agentId) => channelIdFromAgentId(agentId) !== null),
  operatorAgentId: agentIdForChannel(operatorChannelId),
  apply,
  setMode,
});

console.log(
  apply
    ? `Moved ${String(moved)} path(s). Restart the bridge.`
    : "Dry run — nothing changed. Re-run with --apply.",
);

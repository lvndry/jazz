/**
 * @fileoverview One-off move of an existing shared data directory into
 * per-chat sandboxes. The work is shared with the Discord bridge; this only
 * supplies Telegram's id scheme and command line.
 *
 * Prints what it would do and changes nothing until `--apply`.
 *
 * Usage:
 *   bun migrate-isolation.ts --operator <chat id> [--apply]
 */

import { chatIsolationEnabled, setMode } from "@jazz/bot-shared/chat-sandbox";
import { conversationsWithState, migrateToSandboxes } from "@jazz/bot-shared/migrate-isolation";
import { agentIdForChat, isChatAgentId } from "./agents";

const argv = process.argv.slice(2);
const operatorIndex = argv.indexOf("--operator");
const operatorChatId = Number.parseInt(
  operatorIndex === -1 ? "" : (argv[operatorIndex + 1] ?? ""),
  10,
);
const apply = argv.includes("--apply");
const dataDir = process.env["JAZZ_HOME"]?.trim() || "/data";

if (!chatIsolationEnabled()) {
  console.error(
    "Per-chat isolation is not active in this process (needs root, setpriv and useradd, and JAZZ_BOT_CHAT_ISOLATION not set to 0). Nothing to migrate into.",
  );
  process.exit(1);
}
if (!Number.isFinite(operatorChatId)) {
  console.error(
    "Pass --operator <chat id>: the chat that inherits the shared secrets, mail, calendar, GPG and pass stores.",
  );
  process.exit(1);
}

const moved = migrateToSandboxes({
  dataDir,
  agentIds: conversationsWithState(dataDir, isChatAgentId),
  operatorAgentId: agentIdForChat(operatorChatId),
  apply,
  setMode,
});

console.log(
  apply
    ? `Moved ${String(moved)} path(s). Restart the bridge.`
    : "Dry run — nothing changed. Re-run with --apply.",
);

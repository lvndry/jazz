/**
 * WhatsApp → Jazz bridge.
 *
 * A linked device on a WhatsApp account, in the same standing as WhatsApp Web
 * in a browser: it receives what that account receives and replies as it. Every
 * inbound message goes to the shared turn runner, which owns the agent run,
 * approvals, and the answer; what is here is the connection, who is allowed to
 * use it, and when a group message counts as a question for the bot.
 *
 * The protocol is reverse-engineered rather than published, so this is the one
 * bridge whose transport can be taken away: WhatsApp can unlink the device, and
 * a number that behaves unusually can be restricted. A dedicated number is the
 * safer way to run it.
 *
 * Runs on Bun. Configuration is entirely environment variables (see README).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { createTurnRunner, type TurnRunner } from "@jazz/bot-shared/turn";
import qrcode from "qrcode-terminal";
import { type AccessConfig, decideAccess, normalizeJid, parseJidList } from "./access";
import { agentIdForChat, jidFromAgentId } from "./agents";
import { createWhatsAppSurface } from "./surface";
import { connect, type Connection, type WhatsAppMessage } from "./whatsapp";

const STORE_FILES = {
  timezone: "wa-tz.json",
  usage: "wa-usage.json",
  sessions: "wa-sessions.json",
  mode: "wa-mode.json",
} as const;

/** Where inbound attachments are written before the agent is pointed at them. */
const MEDIA_DIR = "wa-media";

/** Chats already reported as refused, so the log says each thing once. */
const loggedRejections = new Set<string>();

interface BridgeConfig extends AccessConfig {
  readonly authDir: string;
  readonly pairWithNumber: string | undefined;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly baseAgentId: string;
  readonly builtinPersonasDir: string;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  readonly dailyCostCapUsd: number;
  readonly showReasoning: boolean;
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
}

function loadConfig(): BridgeConfig {
  const allowedNumbers = parseJidList(process.env["WHATSAPP_ALLOWED_NUMBERS"]?.trim() ?? "");
  const allowedGroups = parseJidList(process.env["WHATSAPP_ALLOWED_GROUPS"]?.trim() ?? "");

  if (allowedNumbers.size === 0 && allowedGroups.size === 0) {
    throw new Error(
      "WHATSAPP_ALLOWED_NUMBERS is empty. This bridge answers on a phone number that " +
        "anyone can write to, so it refuses to start without an allow-list. Set it to a " +
        "comma-separated list of numbers in international form, e.g. +15551234567.",
    );
  }

  const jazzHome = process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz-whatsapp");

  return {
    allowedNumbers,
    allowedGroups,
    requireMentionInGroups: envFlag("WHATSAPP_REQUIRE_MENTION_IN_GROUPS", true),
    // Kept out of JAZZ_HOME's agent tree: these are the linked-device keys, and
    // anything that can read them can act as the account.
    authDir: process.env["WHATSAPP_AUTH_DIR"]?.trim() || join(jazzHome, "wa-auth"),
    pairWithNumber: process.env["WHATSAPP_PAIR_NUMBER"]?.trim() || undefined,
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || "jazz",
    jazzHome,
    baseAgentId: process.env["JAZZ_WHATSAPP_AGENT"]?.trim() || "whatsapp",
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    showReasoning: envFlag("JAZZ_WHATSAPP_SHOW_REASONING", false),
  };
}

/**
 * Does this group message address the bot?
 *
 * Either it @-mentions the linked account, or it replies to one of its
 * messages. Both are resolved against our own JID, which only becomes known
 * once the connection is open — before that nothing can be addressed to us, and
 * treating unknown as "not addressed" keeps a group quiet rather than loud.
 */
function addressesBot(message: WhatsAppMessage, selfJid: string | undefined): boolean {
  if (selfJid === undefined) return false;
  const self = normalizeJid(selfJid);
  if (message.mentions.some((mention) => normalizeJid(mention) === self)) return true;
  // A reply counts only when it replies to *us*; replying to anyone in the
  // thread is ordinary group conversation the agent has no business answering.
  return message.quotedAuthor !== undefined && normalizeJid(message.quotedAuthor) === self;
}

async function promptFrom(
  message: WhatsAppMessage,
  connection: Connection,
  jazzHome: string,
): Promise<string> {
  const parts: string[] = [];
  if (message.text.trim().length > 0) parts.push(message.text.trim());

  if (message.media !== undefined) {
    // Jazz ingests media by path, so the job here ends at "file on disk".
    const path = await connection.saveMedia(message, join(jazzHome, MEDIA_DIR)).catch((error) => {
      console.error(`Failed to download an attachment: ${String(error)}`);
      return undefined;
    });
    if (path !== undefined) parts.push(path);
  }

  return parts.join("\n");
}

async function handleIncoming(
  config: BridgeConfig,
  runner: TurnRunner,
  connection: Connection,
  message: WhatsAppMessage,
): Promise<void> {
  // Our own replies echo back through the same event; answering them would be
  // an unbounded loop.
  if (message.isFromMe) return;

  const decision = decideAccess(config, {
    chatJid: message.chatJid,
    senderJid: message.senderJid,
    addressesBot: addressesBot(message, connection.selfJid),
  });
  if (!decision.allowed) {
    // Never answered: a reply would tell a stranger that something automated
    // reads this number.
    //
    // Logged once per chat rather than per message. A group the agent is in but
    // not addressed by produces a rejection for every message anyone sends, and
    // that would bury the line that actually matters — the one naming a group
    // JID an operator needs in order to add it to the allow-list.
    if (!loggedRejections.has(message.chatJid)) {
      loggedRejections.add(message.chatJid);
      console.error(`Ignoring messages from ${message.chatJid}: ${decision.reason}`);
    }
    return;
  }

  const prompt = await promptFrom(message, connection, config.jazzHome);
  if (prompt.length === 0) return;

  await runner.handle(message.chatJid, prompt);
}

async function start(): Promise<void> {
  const config = loadConfig();

  /**
   * Where inbound messages go once everything is wired.
   *
   * The connection has to exist before the turn runner can be built (the runner
   * sends through it) and the connection needs somewhere to deliver messages,
   * so one of the two is late. A no-op until then drops anything that arrives
   * mid-startup, which is backfill rather than a live question.
   */
  let deliver: (message: WhatsAppMessage) => void = () => {};

  const connection = await connect({
    authDir: config.authDir,
    pairWithNumber: config.pairWithNumber,
    onQr: (qr) => {
      console.error("\nScan this with WhatsApp → Settings → Linked Devices:\n");
      qrcode.generate(qr, { small: true });
    },
    onReady: (selfJid) => {
      console.error(
        `WhatsApp bridge ready as ${selfJid}. ${config.allowedNumbers.size} allowed ` +
          `number(s), ${config.allowedGroups.size} allowed group(s); groups ` +
          `${config.requireMentionInGroups ? "require" : "do not require"} a mention.`,
      );
    },
    onLoggedOut: () => {
      console.error(
        `This device was unlinked from WhatsApp. Delete ${config.authDir} and pair again.`,
      );
      process.exit(1);
    },
    onMessage: (message) => deliver(message),
  });

  const runner = createTurnRunner({
    surface: createWhatsAppSurface(connection),
    jazzBinary: config.jazzBinary,
    jazzHome: config.jazzHome,
    baseAgentId: config.baseAgentId,
    builtinPersonasDir: config.builtinPersonasDir,
    approvalPolicy: config.approvalPolicy,
    autoApproveTools: config.autoApproveTools,
    runTimeoutMs: config.runTimeoutMs,
    dailyCostCapUsd: config.dailyCostCapUsd,
    showReasoning: config.showReasoning,
    files: STORE_FILES,
    agentIdFor: agentIdForChat,
  });

  deliver = (message) => {
    void handleIncoming(config, runner, connection, message).catch((error) =>
      console.error(`Failed to handle message ${message.id}: ${String(error)}`),
    );
  };

  startReminderSweep({
    dataDir: config.jazzHome,
    decodeScope: (agentId) => jidFromAgentId(agentId),
    send: (chatId, body) => runner.send(chatId, body),
  });

  const shutdown = (): void => {
    connection.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void start().catch((error) => {
  console.error(String(error));
  process.exit(1);
});

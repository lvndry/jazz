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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultJazzBinary } from "@jazz/bot-shared/jazz-binary";
import { promptLine } from "@jazz/bot-shared/prompt";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { ensureSeedAgent } from "@jazz/bot-shared/seed-agent";
import { agentStoreDirectory, importSeedAgent } from "@jazz/bot-shared/seed-import";
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

/** How many times to re-ask before giving up on an allow-list. */
const ALLOW_LIST_ATTEMPTS = 3;

/** The seed agent the bridge makes for itself when `--agent` names none. */
const DEFAULT_BASE_AGENT_ID = "whatsapp";

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
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly showReasoning: boolean;
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
}

/** Where an answered allow-list is kept, so the question is asked once. */
export function allowListPath(jazzHome: string): string {
  return join(jazzHome, "wa-allowed.json");
}

/** The saved allow-list, verbatim as it was typed. Empty when there is none. */
export function readSavedAllowList(jazzHome: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(allowListPath(jazzHome), "utf8"));
    const saved = (parsed as { allowedNumbers?: unknown }).allowedNumbers;
    return typeof saved === "string" ? saved : "";
  } catch {
    return "";
  }
}

export function saveAllowList(jazzHome: string, answer: string): void {
  mkdirSync(jazzHome, { recursive: true });
  // Stored as typed rather than normalised, so the file stays editable by hand.
  writeFileSync(
    allowListPath(jazzHome),
    `${JSON.stringify({ allowedNumbers: answer }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

/**
 * Ask whose messages the agent should answer.
 *
 * Only ever called with a terminal attached. Refusing to start is right when
 * nobody is there to be asked, but in front of a person it is just a question
 * with an obvious answer, so it gets asked instead of printed as an error.
 */
async function askForAllowList(jazzHome: string): Promise<string> {
  console.error(
    "\nNo one is allowed to write to this agent yet.\n" +
      "WhatsApp answers on a number anyone can reach, so the bridge needs to know whose\n" +
      "messages to take. Everyone else is ignored.\n",
  );

  for (let attempt = 0; attempt < ALLOW_LIST_ATTEMPTS; attempt += 1) {
    const answer = await promptLine(
      "Whose messages should it answer? Comma-separated, international form\n" +
        "(e.g. +15551234567):",
    );
    if (parseJidList(answer).size > 0) {
      saveAllowList(jazzHome, answer);
      console.error(
        `\nSaved to ${allowListPath(jazzHome)}. Edit or delete that file to change it.\n`,
      );
      return answer;
    }
    console.error("That has no number in it. Write them in international form, e.g. +15551234567.");
  }

  throw new Error("No allow-list given, so the bridge will not start.");
}

async function loadConfig(interactive: boolean): Promise<BridgeConfig> {
  const jazzHome = process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz-whatsapp");

  // The environment wins, then whatever a previous run was told, then a person.
  let allowedNumbers = parseJidList(process.env["WHATSAPP_ALLOWED_NUMBERS"]?.trim() ?? "");
  const allowedGroups = parseJidList(process.env["WHATSAPP_ALLOWED_GROUPS"]?.trim() ?? "");

  if (allowedNumbers.size === 0 && allowedGroups.size === 0) {
    allowedNumbers = parseJidList(readSavedAllowList(jazzHome));
  }

  if (allowedNumbers.size === 0 && allowedGroups.size === 0) {
    if (!interactive) {
      throw new Error(
        "WHATSAPP_ALLOWED_NUMBERS is empty, and there is no terminal to ask. This bridge " +
          "answers on a phone number that anyone can write to, so it will not start without " +
          "an allow-list. Set it to a comma-separated list of numbers in international form, " +
          "e.g. +15551234567, or run `jazz whatsapp` once from a terminal.",
      );
    }
    allowedNumbers = parseJidList(await askForAllowList(jazzHome));
  }

  return {
    allowedNumbers,
    allowedGroups,
    requireMentionInGroups: envFlag("WHATSAPP_REQUIRE_MENTION_IN_GROUPS", true),
    // Kept out of JAZZ_HOME's agent tree: these are the linked-device keys, and
    // anything that can read them can act as the account.
    authDir: process.env["WHATSAPP_AUTH_DIR"]?.trim() || join(jazzHome, "wa-auth"),
    pairWithNumber: process.env["WHATSAPP_PAIR_NUMBER"]?.trim() || undefined,
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || defaultJazzBinary(),
    jazzHome,
    baseAgentId: process.env["JAZZ_WHATSAPP_AGENT"]?.trim() || DEFAULT_BASE_AGENT_ID,
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    provider: process.env["JAZZ_WHATSAPP_PROVIDER"]?.trim() || "openai",
    model: process.env["JAZZ_WHATSAPP_MODEL"]?.trim() || "gpt-5.4",
    reasoningEffort: process.env["JAZZ_REASONING"]?.trim() || "medium",
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

export async function startBridge(): Promise<void> {
  const config = await loadConfig(process.stdin.isTTY === true);

  /**
   * Where inbound messages go once everything is wired.
   *
   * The connection has to exist before the turn runner can be built (the runner
   * sends through it) and the connection needs somewhere to deliver messages,
   * so one of the two is late. A no-op until then drops anything that arrives
   * mid-startup, which is backfill rather than a live question.
   */
  let deliver: (message: WhatsAppMessage) => void = () => {};

  // `--agent` arrives as JAZZ_WHATSAPP_AGENT, so a service inherits it too.
  if (config.baseAgentId !== DEFAULT_BASE_AGENT_ID) {
    const userHome = agentStoreDirectory();
    if (importSeedAgent(userHome, config.jazzHome, config.baseAgentId)) {
      console.error(`Seeded ${config.baseAgentId} from ${userHome} — your original is untouched.`);
    }
  }

  if (
    ensureSeedAgent(config.jazzHome, {
      id: config.baseAgentId,
      name: "Jazz",
      description: "Everyday assistant reachable from WhatsApp.",
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    })
  ) {
    console.error(
      `Created the template agent ${config.baseAgentId} (${config.provider}/${config.model}) ` +
        `in ${config.jazzHome}. Change it per chat with /model, or set JAZZ_WHATSAPP_MODEL.`,
    );
  }

  let codesShown = 0;
  const connection = await connect({
    authDir: config.authDir,
    pairWithNumber: config.pairWithNumber,
    onQr: (qr) => {
      codesShown += 1;
      // Only the newest code is live: WhatsApp expires each one after about a
      // minute and issues another. Printing the new one underneath left a
      // screen of dead codes that look exactly like the live one, and scanning
      // any of them is answered with "check your connection".
      if (codesShown > 1 && process.stderr.isTTY === true)
        process.stderr.write("\u001b[2J\u001b[H");
      console.error(
        codesShown === 1
          ? "\nScan this with WhatsApp → Settings → Linked Devices:\n"
          : `\nThat code expired before it was scanned. Here is a fresh one (#${codesShown}):\n`,
      );
      qrcode.generate(qr, { small: true });
      console.error("\nGood for about a minute, then it is replaced.\n");
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

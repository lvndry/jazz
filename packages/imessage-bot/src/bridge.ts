/**
 * iMessage → Jazz bridge.
 *
 * Reads new messages out of `imsg watch` and hands each one to the shared turn
 * runner, which owns everything from there: serialising the conversation,
 * running the agent, putting approvals in front of a human, sending the answer.
 * What is left here is what only iMessage has — how messages arrive, who is
 * allowed to send them, and how a chat id becomes something `imsg send` can
 * address.
 *
 * It cannot run where the other bridges run. iMessage exists only on a Mac
 * signed into an Apple account, so this is a process on that Mac, and it needs
 * two permissions granted by hand: Full Disk Access (to read the message
 * database) and Automation → Messages (to send). The first is checked at
 * startup rather than discovered as silence.
 *
 * Runs on Bun. Configuration is entirely environment variables (see README).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import {
  readRecordStore,
  recordStorePath,
  writeRecordStore,
} from "@jazz/bot-shared/scoped-record-store";
import type { ChatId } from "@jazz/bot-shared/surface";
import { createTurnRunner, type TurnRunner } from "@jazz/bot-shared/turn";
import { type AccessConfig, decideAccess, parseChatIdList, parseHandleList } from "./access";
import { agentIdForChat, chatIdFromAgentId } from "./agents";
import {
  checkImsg,
  type ImsgChat,
  type ImsgMessage,
  type ImsgTarget,
  listChats,
  watchMessages,
} from "./imsg";
import { confirm, homebrewPresent, installImsg, planInstall } from "./install";
import { createIMessageSurface } from "./surface";

const STORE_FILES = {
  timezone: "im-tz.json",
  usage: "im-usage.json",
  sessions: "im-sessions.json",
  mode: "im-mode.json",
} as const;

/** Where the last handled `chat.db` rowid is kept, so a restart resumes cleanly. */
const CURSOR_FILE = "im-cursor.json";
const CURSOR_KEY = "lastRowId";

/** How many chats to pull when refreshing the chat metadata cache. */
const CHAT_LIST_LIMIT = 200;

interface BridgeConfig extends AccessConfig {
  readonly imsgBinary: string;
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
  const allowedHandles = parseHandleList(process.env["IMESSAGE_ALLOWED_HANDLES"]?.trim() ?? "");
  const allowedGroupChatIds = parseChatIdList(
    process.env["IMESSAGE_ALLOWED_GROUP_CHAT_IDS"]?.trim() ?? "",
  );

  if (allowedHandles.size === 0 && allowedGroupChatIds.size === 0) {
    throw new Error(
      "IMESSAGE_ALLOWED_HANDLES is empty. This bridge answers on a phone number that " +
        "anyone can text, so it refuses to start without an allow-list. Set it to a " +
        "comma-separated list of phone numbers (E.164, e.g. +15551234567) or Apple IDs.",
    );
  }

  return {
    allowedHandles,
    allowedGroupChatIds,
    imsgBinary: process.env["IMSG_BIN"]?.trim() || "imsg",
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || "jazz",
    // Not `/data`: unlike the containerised bridges this runs as a normal
    // process on someone's Mac, where an absolute root path is neither
    // writable nor expected.
    jazzHome: process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz-imessage"),
    baseAgentId: process.env["JAZZ_IMESSAGE_AGENT"]?.trim() || "imessage",
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    showReasoning: envFlag("JAZZ_IMESSAGE_SHOW_REASONING", false),
  };
}

/**
 * Chat rowid → what `imsg chats` knows about it.
 *
 * A watch event carries `chat_id` but not whether that chat is a group, and the
 * access decision turns on exactly that. Refreshed on a miss rather than per
 * message: the answer only changes when a new conversation appears.
 */
const chatCache = new Map<number, ImsgChat>();

async function refreshChats(config: BridgeConfig): Promise<void> {
  for (const chat of await listChats(config.imsgBinary, CHAT_LIST_LIMIT)) {
    chatCache.set(chat.id, chat);
  }
}

async function chatFor(config: BridgeConfig, chatId: number): Promise<ImsgChat | undefined> {
  const cached = chatCache.get(chatId);
  if (cached !== undefined) return cached;
  await refreshChats(config);
  return chatCache.get(chatId);
}

/**
 * Address a send.
 *
 * Always by rowid: a group has no single handle to send to, and even for a DM
 * the rowid is what the conversation was identified by, so routing through it
 * cannot deliver into a different thread with the same person.
 */
function targetFor(chatId: ChatId): ImsgTarget {
  return { kind: "chat", chatId: Number.parseInt(chatId, 10) };
}

function readCursor(dataDir: string): number | undefined {
  const store = readRecordStore<number>(recordStorePath(dataDir, CURSOR_FILE));
  const value = store?.[CURSOR_KEY];
  return typeof value === "number" ? value : undefined;
}

function writeCursor(dataDir: string, rowId: number): void {
  writeRecordStore(recordStorePath(dataDir, CURSOR_FILE), { [CURSOR_KEY]: rowId });
}

/**
 * Turn an inbound message into the prompt the agent sees.
 *
 * Attachments are handed over as paths rather than bytes: Jazz ingests media by
 * path, and an iMessage attachment is already a local file, so there is nothing
 * to download — the one thing this bridge has easier than the others.
 */
function promptFrom(message: ImsgMessage): string {
  const parts: string[] = [];
  if (message.replyToText !== undefined) parts.push(`[replying to: ${message.replyToText}]`);
  if (message.text.trim().length > 0) parts.push(message.text.trim());
  for (const attachment of message.attachments) {
    if (attachment.missing) continue;
    parts.push(attachment.convertedPath ?? attachment.originalPath);
  }
  return parts.join("\n");
}

async function handleIncoming(
  config: BridgeConfig,
  runner: TurnRunner,
  message: ImsgMessage,
): Promise<void> {
  // Our own replies come back through the same watch stream; answering them
  // would be an unbounded loop with a person watching it happen.
  if (message.isFromMe) return;
  // A tapback is an event about another message, not a message to answer.
  if (message.isReaction) return;

  const prompt = promptFrom(message);
  if (prompt.length === 0) return;

  const chat = await chatFor(config, message.chatId);
  const decision = decideAccess(config, {
    sender: message.sender,
    chatId: message.chatId,
    isGroup: chat?.isGroup ?? false,
  });
  if (!decision.allowed) {
    // Logged, never answered: replying would confirm to a stranger that
    // something automated is reading this number.
    console.error(`Ignored a message: ${decision.reason}`);
    return;
  }

  await runner.handle(String(message.chatId), prompt);
}

/**
 * Make sure `imsg` is installed and can read the message database, offering to
 * install it when a person is there to be asked.
 *
 * Re-checked after a successful install rather than assumed: a fresh install
 * still has to get past Full Disk Access, and that is the failure most people
 * will actually hit.
 */
async function ensureImsgUsable(binary: string): Promise<boolean> {
  const plan = planInstall(await checkImsg(binary), {
    interactive: process.stdin.isTTY === true,
    homebrewPresent: await homebrewPresent(),
  });

  if (plan.action === "proceed") return true;
  if (plan.action === "explain") {
    console.error(plan.message);
    return false;
  }

  console.error(plan.message);
  if (!(await confirm("Install it?"))) {
    console.error("Not installing. The iMessage bridge cannot run without it.");
    return false;
  }
  if (!(await installImsg())) return false;

  // Re-checked rather than assumed: a freshly installed `imsg` still has to get
  // past Full Disk Access, which is the failure most people actually hit, and
  // the second pass is what names it instead of reporting a missing package.
  const afterInstall = planInstall(await checkImsg(binary), {
    interactive: false,
    homebrewPresent: true,
  });
  if (afterInstall.action === "proceed") return true;
  console.error(afterInstall.message);
  return false;
}

async function start(): Promise<void> {
  const config = loadConfig();

  if (!(await ensureImsgUsable(config.imsgBinary))) process.exit(1);

  const surface = createIMessageSurface({
    binary: config.imsgBinary,
    resolveTarget: targetFor,
  });
  const runner = createTurnRunner({
    surface,
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
    agentIdFor: (chatId) => agentIdForChat(Number.parseInt(chatId, 10)),
  });

  await refreshChats(config);
  console.error(
    `iMessage bridge ready. ${config.allowedHandles.size} allowed handle(s), ` +
      `${config.allowedGroupChatIds.size} allowed group(s), ${chatCache.size} chat(s) known.`,
  );

  startReminderSweep({
    dataDir: config.jazzHome,
    decodeScope: (agentId) => {
      const chatId = chatIdFromAgentId(agentId);
      return chatId === undefined ? undefined : String(chatId);
    },
    send: (chatId, body) => runner.send(chatId, body),
  });

  const watcher = watchMessages({
    binary: config.imsgBinary,
    sinceRowId: readCursor(config.jazzHome),
    includeAttachments: true,
    onRestart: (reason) => console.error(`${reason}; restarting the watcher.`),
    onMessage: (message) => {
      writeCursor(config.jazzHome, message.id);
      void handleIncoming(config, runner, message).catch((error) =>
        console.error(`Failed to handle message ${message.id}: ${String(error)}`),
      );
    },
  });

  const shutdown = (): void => {
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void start().catch((error) => {
  console.error(String(error));
  process.exit(1);
});

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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import {
  readRecordStore,
  recordStorePath,
  writeRecordStore,
} from "@jazz/bot-shared/scoped-record-store";
import { ensureSeedAgent } from "@jazz/bot-shared/seed-agent";
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
import {
  confirm,
  homebrewPresent,
  installImsg,
  openFullDiskAccessSettings,
  planInstall,
} from "./install";
import {
  bootstrapService,
  carriedEnvironment,
  runningUnderLaunchd,
  serviceInstalled,
  SERVICE_LABEL,
  writeServicePlist,
} from "./service";
import { createIMessageSurface, type IMessageSurface } from "./surface";

const STORE_FILES = {
  timezone: "im-tz.json",
  usage: "im-usage.json",
  sessions: "im-sessions.json",
  mode: "im-mode.json",
} as const;

/** Where the last handled `chat.db` rowid is kept, so a restart resumes cleanly. */
const CURSOR_FILE = "im-cursor.json";
const CURSOR_KEY = "lastRowId";

/**
 * The word that makes a message you send yourself a question for the agent.
 *
 * Used when a first run has nothing configured — the one setting that makes the
 * bridge useful while still admitting nobody but the account owner.
 */
const DEFAULT_SELF_TRIGGER = "jazz";

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
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly showReasoning: boolean;
  /**
   * Prefix that makes a message you send yourself a question for the agent.
   *
   * Without it a solo operator cannot reach their own bridge at all: iMessage
   * marks everything you type as from you, including in a chat with yourself,
   * and the bridge has to ignore those or it answers its own replies forever.
   * Unset leaves self-messages ignored entirely.
   */
  readonly selfTrigger: string | undefined;
}

/**
 * The Jazz binary a run is spawned with.
 *
 * When the bridge runs inside the Jazz binary, that binary is this process, and
 * naming it directly beats a PATH lookup that could resolve to a different
 * install. Under `bun bridge.ts` the executable is bun, which cannot run a Jazz
 * turn, so that case falls back to the name.
 */
/**
 * The arguments the service needs after the binary.
 *
 * Inside the Jazz binary that is the subcommand; under `bun` it is the path of
 * this file, which is what bun was given.
 */
function serviceArgs(): readonly string[] {
  if (defaultJazzBinary() === process.execPath) return ["imessage"];
  // Started with `bun`, so the service runs the same script entry point.
  return [join(dirname(fileURLToPath(import.meta.url)), "main.ts")];
}

function defaultJazzBinary(): string {
  const executable = process.execPath;
  return executable.endsWith("/jazz") ? executable : "jazz";
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
}

function loadConfig(interactive: boolean): BridgeConfig {
  const allowedHandles = parseHandleList(process.env["IMESSAGE_ALLOWED_HANDLES"]?.trim() ?? "");
  const allowedGroupChatIds = parseChatIdList(
    process.env["IMESSAGE_ALLOWED_GROUP_CHAT_IDS"]?.trim() ?? "",
  );

  let selfTrigger = process.env["IMESSAGE_SELF_TRIGGER"]?.trim().toLowerCase() || undefined;
  const nothingConfigured =
    allowedHandles.size === 0 && allowedGroupChatIds.size === 0 && selfTrigger === undefined;

  if (nothingConfigured && interactive) {
    // Starting with nothing configured is what a first run looks like, and it
    // should work rather than teach environment variables. The self trigger is
    // the safe default to land on: it opens the bridge to exactly one person —
    // whoever is already signed in on this Mac — and to nobody else.
    selfTrigger = DEFAULT_SELF_TRIGGER;
    console.error(
      `No one is allowed to text this agent yet, so it will answer only you.\n` +
        `Text yourself "${DEFAULT_SELF_TRIGGER} <question>" to try it.\n` +
        `To let others in, set IMESSAGE_ALLOWED_HANDLES to their numbers.\n`,
    );
  } else if (nothingConfigured) {
    throw new Error(
      "IMESSAGE_ALLOWED_HANDLES is empty, and there is no terminal to ask. This bridge " +
        "answers on a phone number anyone can text, so it will not start without an " +
        "allow-list. Set it to a comma-separated list of phone numbers (E.164) or Apple IDs.",
    );
  }

  return {
    allowedHandles,
    allowedGroupChatIds,
    imsgBinary: process.env["IMSG_BIN"]?.trim() || "imsg",
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || defaultJazzBinary(),
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
    provider: process.env["JAZZ_IMESSAGE_PROVIDER"]?.trim() || "openai",
    model: process.env["JAZZ_IMESSAGE_MODEL"]?.trim() || "gpt-5.4",
    reasoningEffort: process.env["JAZZ_REASONING"]?.trim() || "medium",
    showReasoning: envFlag("JAZZ_IMESSAGE_SHOW_REASONING", false),
    selfTrigger,
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

/**
 * Should a message the account owner sent be treated as a question?
 *
 * Everything this bridge sends comes back marked as from the owner, so the
 * default is no. With a trigger configured, a message that opens with it is one
 * the owner typed deliberately — which is the only way a person with no second
 * device can talk to their own bridge.
 *
 * Two independent guards keep this from looping: the bridge's own sends are
 * recognised and dropped whatever they say, and a reply would additionally have
 * to begin with the trigger to get this far.
 */
function selfPrompt(
  config: BridgeConfig,
  surface: IMessageSurface,
  prompt: string,
): string | undefined {
  if (surface.wasSentByUs(prompt)) return undefined;
  if (config.selfTrigger === undefined) return undefined;
  if (!prompt.toLowerCase().startsWith(config.selfTrigger)) return undefined;
  const stripped = prompt.slice(config.selfTrigger.length).trim();
  return stripped.length > 0 ? stripped : undefined;
}

async function handleIncoming(
  config: BridgeConfig,
  runner: TurnRunner,
  surface: IMessageSurface,
  message: ImsgMessage,
): Promise<void> {
  // A tapback is an event about another message, not a message to answer.
  if (message.isReaction) return;

  const raw = promptFrom(message);
  if (raw.length === 0) return;

  if (message.isFromMe) {
    // No allow-list check: this is the account owner typing on their own Mac,
    // which is the one identity the allow-list exists to establish.
    const prompt = selfPrompt(config, surface, raw);
    if (prompt === undefined) return;
    await runner.handle(String(message.chatId), prompt);
    return;
  }

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

  await runner.handle(String(message.chatId), raw);
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
  const planContext = {
    interactive: process.stdin.isTTY === true,
    homebrewPresent: await homebrewPresent(),
    // This process's own binary: what launchd hands macOS as the responsible
    // process, and so what the grant has to name.
    grantPath: process.execPath,
  };
  const plan = planInstall(await checkImsg(binary), planContext);

  if (plan.action === "proceed") return true;
  if (plan.action === "explain") {
    console.error(plan.message);
    return false;
  }
  if (plan.action === "grant") {
    console.error(plan.message);
    console.error(
      `\nAdd this in System Settings → Privacy & Security → Full Disk Access:\n` +
        `  ${plan.grantPath}\n`,
    );
    if (await confirm("Open that page and copy the path now?")) {
      await openFullDiskAccessSettings(plan.grantPath);
      console.error("\nClick +, press Cmd-Shift-G, paste, then run Jazz again.");
    }
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
    ...planContext,
    // Not a prompt: the install just ran, and anything still wrong is for the
    // person to read rather than answer.
    interactive: false,
  });
  if (afterInstall.action === "proceed") return true;
  console.error(afterInstall.message);
  return false;
}

/**
 * Offer to keep the bridge running once it is actually working.
 *
 * Asked here rather than at startup because until this point there was nothing
 * worth installing: a bridge that cannot read the message database or reach a
 * model is not one to bring back at every login.
 *
 * Installing does not start a second copy — the answer says to stop this one
 * first — because two bridges on one account both answer every message.
 */
async function maybeOfferService(config: BridgeConfig): Promise<void> {
  if (runningUnderLaunchd() || serviceInstalled()) return;
  if (process.stdin.isTTY !== true) return;

  console.error(
    "\nThis is running in the foreground and stops when you close the terminal.\n" +
      "Installing it as a background service also narrows the Full Disk Access grant: " +
      "macOS holds the terminal responsible for what you start from it, and this binary " +
      "for what launchd starts.",
  );
  if (!(await confirm("Install it as a background service?"))) return;

  try {
    const path = writeServicePlist({
      runtime: process.execPath,
      // The same command that started this one, so the service and a person
      // invoke the bridge identically.
      args: serviceArgs(),
      workingDirectory: process.cwd(),
      jazzHome: config.jazzHome,
      // The first-run self trigger is a safe default held in config rather
      // than process.env. Carry it explicitly so the background service
      // starts with the same admission rule as the foreground bridge.
      environment: carriedEnvironment(process.env, {
        IMESSAGE_SELF_TRIGGER: config.selfTrigger,
      }),
    });
    console.error(`\nWrote ${path}`);

    // Handing over rather than starting alongside: two bridges on one account
    // both answer every message, so this process ends as the service begins.
    if (await bootstrapService()) {
      console.error(
        `\nRunning in the background now. Follow it with:\n` +
          `  tail -f ${config.jazzHome}/bridge.log\n\n` +
          `Stop it with:    launchctl bootout gui/$(id -u)/${SERVICE_LABEL}\n` +
          `Restart it with: launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`,
      );
      process.exit(0);
    }

    console.error(
      `\nlaunchctl would not start it. Stop this one (Ctrl-C) and try by hand:\n` +
        `  launchctl bootstrap gui/$(id -u) ${path}`,
    );
  } catch (error) {
    console.error(`Could not install the service: ${String(error)}`);
  }
}

export async function startBridge(): Promise<void> {
  const config = loadConfig(process.stdin.isTTY === true);

  if (!(await ensureImsgUsable(config.imsgBinary))) process.exit(1);

  if (
    ensureSeedAgent(config.jazzHome, {
      id: config.baseAgentId,
      name: "Jazz",
      description: "Everyday assistant reachable from iMessage.",
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    })
  ) {
    console.error(
      `Created the template agent ${config.baseAgentId} (${config.provider}/${config.model}) ` +
        `in ${config.jazzHome}. Change it per chat with /model, or set JAZZ_IMESSAGE_MODEL.`,
    );
  }

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

  await maybeOfferService(config);

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
      void handleIncoming(config, runner, surface, message).catch((error) =>
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

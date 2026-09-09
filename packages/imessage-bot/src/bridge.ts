/**
 * iMessage → Jazz bridge.
 *
 * Reads new messages out of `imsg watch` and answers each one with a per-chat
 * Jazz agent, exactly as the Telegram and Discord bridges do. What is different
 * is the surface: iMessage cannot edit a sent message and has no buttons, so
 * there is no live progress bubble and no tap-to-approve — the shared core
 * falls back to an acknowledgement plus a final answer, and approvals are
 * answered by replying with a number.
 *
 * It also cannot run where the other two run. iMessage exists only on a Mac
 * signed into an Apple account, so this is a process on that Mac rather than a
 * container on a server, and it needs two permissions granted by hand:
 * Full Disk Access (to read the message database) and Automation → Messages
 * (to send). Both are checked at startup rather than discovered as silence.
 *
 * Runs on Bun. Configuration is entirely environment variables (see README).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_MODE_LABELS,
  type ApprovalMode,
  approvalModeFor,
  approvalPolicyFor,
  describeApprovalMode,
  setApprovalMode,
} from "@jazz/bot-shared/approval-mode-store";
import { type ChatSandbox, ensureChatSandbox } from "@jazz/bot-shared/chat-sandbox";
import {
  type JazzEnvelope,
  type JazzEvent,
  type JazzRun,
  startJazzRun,
} from "@jazz/bot-shared/jazz-run";
import { listPersonaNames } from "@jazz/bot-shared/personas";
import { createProgressReporter } from "@jazz/bot-shared/progress";
import { splitReasoning } from "@jazz/bot-shared/reasoning";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { createRunLog } from "@jazz/bot-shared/run-log";
import {
  readRecordStore,
  recordStorePath,
  writeRecordStore,
} from "@jazz/bot-shared/scoped-record-store";
import { conversationKey, startNewConversation } from "@jazz/bot-shared/session-store";
import {
  bold,
  type ChatId,
  type Choice,
  code,
  line,
  matchChoice,
  plainLine,
  type RichText,
} from "@jazz/bot-shared/surface";
import { isValidTimeZone, setTzForChat, tzForChat } from "@jazz/bot-shared/timezone-store";
import {
  capBlockMessage,
  dailyCostCapBlockReason,
  recordUsage,
  todayUsage,
} from "@jazz/bot-shared/usage-store";
import { parseProviderModel } from "@jazz/core/utils/provider-model";
import { type AccessConfig, decideAccess, parseChatIdList, parseHandleList } from "./access";
import {
  agentIdForChat,
  chatIdFromAgentId,
  ensureChatAgent,
  readAgentFile,
  writeChatAgentFile,
} from "./agents";
import {
  checkImsg,
  type ImsgChat,
  type ImsgMessage,
  type ImsgTarget,
  listChats,
  watchMessages,
} from "./imsg";
import { createIMessageSurface } from "./surface";

const TZ_FILE = "im-tz.json";
const USAGE_FILE = "im-usage.json";
const EPOCHS_FILE = "im-sessions.json";
const MODE_FILE = "im-mode.json";
/** Where the last handled `chat.db` rowid is kept, so a restart resumes cleanly. */
const CURSOR_FILE = "im-cursor.json";
const CURSOR_KEY = "lastRowId";

/** How many chats to pull when refreshing the chat metadata cache. */
const CHAT_LIST_LIMIT = 200;

const BRIDGE_STARTED_AT = Date.now();

/**
 * iMessage has no bold and no code spans, so the shared mode wording renders
 * with its marks dropped rather than with literal asterisks or backticks.
 */
const PLAIN_MARKUP = { bold: (value: string) => value, code: (value: string) => value };

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
  /** Attach the run's full reasoning under the answer. */
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

// --- Chat metadata --------------------------------------------------------

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

// --- Cursor ---------------------------------------------------------------

function readCursor(dataDir: string): number | undefined {
  const store = readRecordStore<number>(recordStorePath(dataDir, CURSOR_FILE));
  const value = store?.[CURSOR_KEY];
  return typeof value === "number" ? value : undefined;
}

function writeCursor(dataDir: string, rowId: number): void {
  writeRecordStore(recordStorePath(dataDir, CURSOR_FILE), { [CURSOR_KEY]: rowId });
}

// --- Per-chat run state ---------------------------------------------------

/**
 * A prompt the person is expected to answer next, on a surface with no buttons.
 *
 * Their reply is offered to this before it is treated as a new question, and
 * `matchChoice` returning undefined is what lets an unrelated message fall
 * through to the agent instead of being swallowed as a mis-read decision.
 */
type PendingPrompt =
  | { readonly kind: "approval"; readonly toolCallId: string; readonly choices: readonly Choice[] }
  | { readonly kind: "question"; readonly requestId: string; readonly choices: readonly Choice[] };

interface ChatState {
  /**
   * Whether this chat is mid-turn. Set before the first await of handling so
   * concurrent inbound messages cannot both begin a run.
   */
  busy: boolean;
  run?: JazzRun | undefined;
  pending?: PendingPrompt | undefined;
  /** Messages that arrived mid-turn, answered in order once it finishes. */
  readonly queue: string[];
}

const chatStates = new Map<number, ChatState>();

function stateFor(chatId: number): ChatState {
  const existing = chatStates.get(chatId);
  if (existing !== undefined) return existing;
  const created: ChatState = { busy: false, queue: [] };
  chatStates.set(chatId, created);
  return created;
}

// --- Presentation ---------------------------------------------------------

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${totalMinutes % 60}m`);
  return parts.join(" ");
}

/** The one-line "what that run cost" trailer appended under an answer. */
function runSummary(envelope: JazzEnvelope, toolCount: number): string {
  if (!envelope.ok) return "";
  const bits = [`✅ ${toolCount} tool${toolCount === 1 ? "" : "s"}`];
  const usage = envelope.tokenUsage;
  const totalTokens = usage?.totalTokens ?? 0;
  if (totalTokens > 0) bits.push(`${formatTokenCount(totalTokens)} tokens`);
  if (envelope.costKnown !== false && envelope.costUSD > 0) {
    bits.push(`$${envelope.costUSD.toFixed(4)}`);
  }
  return bits.join(" · ");
}

// --- The turn -------------------------------------------------------------

const surface = createIMessageSurface({
  binary: process.env["IMSG_BIN"]?.trim() || "imsg",
  resolveTarget: targetFor,
});

function sandboxForChat(config: BridgeConfig, chatId: number): ChatSandbox {
  return ensureChatSandbox(config.jazzHome, agentIdForChat(chatId));
}

async function send(chatId: number, body: RichText): Promise<void> {
  await surface.send(String(chatId), { body });
}

/**
 * Put an approval in front of the person as a numbered choice.
 *
 * Two options rather than Telegram's three: "always allow this command" writes
 * to the agent's config and is a decision worth making somewhere the full text
 * of what is being permitted is visible, not by texting a digit.
 */
function approvalChoices(): readonly Choice[] {
  return [
    { id: "approve", label: "Approve", intent: "primary" },
    { id: "reject", label: "Reject", intent: "danger" },
  ];
}

async function announceApproval(chatId: number, event: JazzEvent): Promise<void> {
  const toolCallId = event.toolCallId;
  if (toolCallId === undefined) return;

  const body: RichText = [
    line(bold("⚠️ Approval needed")),
    line(code(event.toolName ?? "tool")),
    ...(event.message ? [plainLine(event.message)] : []),
    ...(event.previewDiff ? [plainLine(event.previewDiff)] : []),
  ];
  const choices = approvalChoices();
  stateFor(chatId).pending = { kind: "approval", toolCallId, choices };
  await surface.send(String(chatId), { body, choices });
}

async function announceQuestion(chatId: number, event: JazzEvent): Promise<void> {
  const requestId = event.requestId;
  const question = event.question?.trim();
  if (requestId === undefined || !question) return;

  const suggestions = event.suggestions ?? [];
  const choices: readonly Choice[] = suggestions.map((suggestion) => ({
    id: suggestion.value,
    label: suggestion.label ?? suggestion.value,
  }));

  const body: RichText = [
    line(bold("❓ The agent needs an answer")),
    plainLine(question),
    ...suggestions
      .filter((suggestion) => suggestion.description !== undefined)
      .map((suggestion) =>
        plainLine(`• ${suggestion.label ?? suggestion.value} — ${suggestion.description ?? ""}`),
      ),
  ];

  stateFor(chatId).pending = { kind: "question", requestId, choices };
  await surface.send(String(chatId), {
    body,
    // With no suggestions there is nothing to number: the person answers in
    // their own words and the next message is forwarded verbatim.
    ...(choices.length > 0 ? { choices } : {}),
  });
}

/**
 * Answer a pending prompt with the person's reply, if it is one.
 *
 * Returns whether the reply was consumed. A free-text question has no choices,
 * so anything the person says next is the answer; a numbered prompt only
 * consumes a reply that actually matches an option.
 */
async function resolvePending(chatId: number, reply: string): Promise<boolean> {
  const state = stateFor(chatId);
  const pending = state.pending;
  const run = state.run;
  if (pending === undefined || run === undefined) return false;

  if (pending.kind === "question" && pending.choices.length === 0) {
    state.pending = undefined;
    await run.answerQuestion(pending.requestId, reply);
    return true;
  }

  const choice = matchChoice(pending.choices, reply);
  if (choice === undefined) return false;
  state.pending = undefined;

  if (pending.kind === "approval") {
    await run.approve([{ toolCallId: pending.toolCallId, approved: choice.id === "approve" }]);
  } else {
    await run.answerQuestion(pending.requestId, choice.id);
  }
  return true;
}

async function answer(config: BridgeConfig, chatId: number, prompt: string): Promise<void> {
  const capBlock = dailyCostCapBlockReason(
    todayUsage(config.jazzHome, USAGE_FILE),
    config.dailyCostCapUsd,
  );
  if (capBlock !== undefined) {
    await send(chatId, [plainLine(capBlockMessage(capBlock, config.dailyCostCapUsd))]);
    return;
  }

  const state = stateFor(chatId);
  const sandbox = sandboxForChat(config, chatId);
  ensureChatAgent(config.jazzHome, sandbox, chatId, config.baseAgentId);

  const conversation = conversationKey(config.jazzHome, EPOCHS_FILE, chatId);
  const runLog = createRunLog(sandbox.home, conversation);
  const reporter = createProgressReporter({ surface, chatId: String(chatId), runLog });
  await reporter.start();

  const run = startJazzRun(
    {
      jazzBinary: config.jazzBinary,
      agentId: agentIdForChat(chatId),
      sandbox,
      approvalPolicy: approvalPolicyFor(config.jazzHome, MODE_FILE, chatId, config.approvalPolicy),
      autoApproveTools: config.autoApproveTools,
      timezone: tzForChat(config.jazzHome, TZ_FILE, chatId),
      runTimeoutMs: config.runTimeoutMs,
      conversation: { kind: "persistent", key: conversation },
      prompt,
    },
    {
      onEvent: (event) => reporter.onEvent(event),
      onApprovalRequired: (event) => {
        void announceApproval(chatId, event).catch((error) =>
          console.error(`Failed to send approval request to ${chatId}: ${String(error)}`),
        );
      },
      onUserInputRequired: (event) => {
        void announceQuestion(chatId, event).catch((error) =>
          console.error(`Failed to send question to ${chatId}: ${String(error)}`),
        );
      },
    },
  );
  state.run = run;

  const envelope = await run.result;
  state.run = undefined;
  // A prompt outstanding when the run ends is one nothing will ever read, and
  // leaving it set would eat the person's next message.
  state.pending = undefined;
  runLog.finish(envelope);

  if (!envelope.ok) {
    await reporter.finish([plainLine(`⚠️ ${envelope.error}`)]);
    await send(chatId, [plainLine(`⚠️ ${envelope.error}`)]);
    return;
  }

  recordUsage(
    config.jazzHome,
    USAGE_FILE,
    envelope.costUSD,
    envelope.tokenUsage?.totalTokens ?? 0,
    envelope.costKnown !== false,
  );

  const summary = runSummary(envelope, reporter.toolsUsed().length);
  const summaryShown = await reporter.finish([plainLine(summary)]);

  const body: RichText = [
    plainLine(envelope.answer),
    // On this surface `finish` never displays the summary — there is no bubble
    // to close — so it rides under the answer rather than costing its own
    // notification.
    ...(summaryShown || summary.length === 0 ? [] : [plainLine(""), plainLine(summary)]),
  ];
  await surface.send(String(chatId), { body });

  if (config.showReasoning) {
    const parts = splitReasoning(reporter.reasoningLog(), { budget: 1_500, maxParts: 2 });
    for (const part of parts) {
      await send(chatId, [line(bold("💭 Reasoning")), plainLine(part)]);
    }
  }

  // A static `create_web_app` result is an image, and an image is something
  // iMessage can actually show — the interactive mode needs a URL to open,
  // which a bridge with no public origin cannot offer.
  const imagePath = envelope.webApp?.imagePath;
  if (imagePath !== undefined && surface.sendFile !== undefined) {
    await surface
      .sendFile(String(chatId), imagePath, envelope.webApp?.title)
      .catch((error) => console.error(`Failed to send web app image: ${String(error)}`));
  }
}

// --- Commands -------------------------------------------------------------

const HELP: RichText = [
  line(bold("Jazz over iMessage")),
  plainLine("Just text normally — every message runs the agent."),
  plainLine(""),
  plainLine("/new — start a fresh conversation (keeps model and persona)"),
  plainLine("/model provider/model — switch this chat's model"),
  plainLine("/persona name — switch this chat's persona"),
  plainLine("/mode safe|yolo — whether risky tools stop to ask"),
  plainLine("/tz Europe/Paris — set the timezone reminders resolve in"),
  plainLine("/status — model, mode, timezone, today's usage"),
  plainLine("/help — this message"),
  plainLine(""),
  plainLine("When the agent asks something, reply with the option's number."),
];

async function handleStatus(config: BridgeConfig, chatId: number): Promise<void> {
  const sandbox = sandboxForChat(config, chatId);
  const agent = readAgentFile(sandbox.home, agentIdForChat(chatId));
  const usage = todayUsage(config.jazzHome, USAGE_FILE);
  const mode = approvalModeFor(config.jazzHome, MODE_FILE, chatId);

  await send(chatId, [
    line(bold("Status")),
    plainLine(`Model: ${agent.config.llmProvider}/${agent.config.llmModel}`),
    plainLine(`Persona: ${agent.config.persona}`),
    plainLine(`Mode: ${APPROVAL_MODE_LABELS[mode]}`),
    plainLine(`Timezone: ${tzForChat(config.jazzHome, TZ_FILE, chatId)}`),
    plainLine(
      `Today: ${usage.runs} run${usage.runs === 1 ? "" : "s"} · ` +
        `${formatTokenCount(usage.tokens)} tokens · $${usage.costUSD.toFixed(4)}` +
        (config.dailyCostCapUsd > 0 ? ` of $${config.dailyCostCapUsd.toFixed(2)}` : ""),
    ),
    plainLine(`Uptime: ${formatUptime(Date.now() - BRIDGE_STARTED_AT)}`),
  ]);
}

async function handleModel(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const sandbox = sandboxForChat(config, chatId);
  const agent = readAgentFile(sandbox.home, agentIdForChat(chatId));

  if (args.length === 0) {
    await send(chatId, [
      plainLine(`Current model: ${agent.config.llmProvider}/${agent.config.llmModel}`),
      plainLine("Switch with /model provider/model, e.g. /model anthropic/claude-sonnet-5"),
    ]);
    return;
  }

  const parsed = parseProviderModel(args);
  if (parsed === null) {
    await send(chatId, [
      plainLine(`Could not read "${args}" as provider/model.`),
      plainLine("Try /model anthropic/claude-sonnet-5"),
    ]);
    return;
  }

  agent.config.llmProvider = parsed.provider;
  agent.config.llmModel = parsed.model;
  writeChatAgentFile(sandbox, agent);
  await send(chatId, [plainLine(`✅ Model → ${parsed.provider}/${parsed.model}`)]);
}

async function handlePersona(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const sandbox = sandboxForChat(config, chatId);
  const agent = readAgentFile(sandbox.home, agentIdForChat(chatId));
  const available = await listPersonaNames(sandbox.home, config.builtinPersonasDir);

  if (args.length === 0) {
    await send(chatId, [
      plainLine(`Current persona: ${agent.config.persona}`),
      plainLine(`Available: ${available.join(", ")}`),
    ]);
    return;
  }
  if (!available.includes(args)) {
    await send(chatId, [
      plainLine(`No persona called "${args}".`),
      plainLine(`Available: ${available.join(", ")}`),
    ]);
    return;
  }

  agent.config.persona = args;
  writeChatAgentFile(sandbox, agent);
  await send(chatId, [plainLine(`✅ Persona → ${args}`)]);
}

async function handleMode(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const current = approvalModeFor(config.jazzHome, MODE_FILE, chatId);
  const requested = args.toLowerCase();

  if (requested !== "safe" && requested !== "yolo") {
    await send(chatId, [
      plainLine(`Mode: ${APPROVAL_MODE_LABELS[current]}`),
      plainLine(describeApprovalMode(current, config.approvalPolicy, PLAIN_MARKUP)),
      plainLine("Set it with /mode safe or /mode yolo."),
    ]);
    return;
  }

  const mode: ApprovalMode = requested;
  setApprovalMode(config.jazzHome, MODE_FILE, chatId, mode);
  await send(chatId, [
    plainLine(`✅ Mode → ${APPROVAL_MODE_LABELS[mode]}`),
    plainLine(describeApprovalMode(mode, config.approvalPolicy, PLAIN_MARKUP)),
  ]);
}

async function handleTz(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  if (args.length === 0) {
    await send(chatId, [
      plainLine(`Timezone: ${tzForChat(config.jazzHome, TZ_FILE, chatId)}`),
      plainLine("Set it with /tz Europe/Paris"),
    ]);
    return;
  }
  if (!isValidTimeZone(args)) {
    await send(chatId, [plainLine(`"${args}" is not an IANA timezone. Try /tz Europe/Paris`)]);
    return;
  }
  setTzForChat(config.jazzHome, TZ_FILE, chatId, args);
  await send(chatId, [plainLine(`✅ Timezone → ${args}`)]);
}

/** Returns true when the text was a command and has been dealt with. */
async function handleCommand(config: BridgeConfig, chatId: number, body: string): Promise<boolean> {
  if (!body.startsWith("/")) return false;
  const [rawCommand, ...rest] = body.slice(1).split(/\s+/);
  const command = (rawCommand ?? "").toLowerCase();
  const args = rest.join(" ").trim();

  switch (command) {
    case "help":
      await send(chatId, HELP);
      return true;
    case "new":
    case "reset":
      startNewConversation(config.jazzHome, EPOCHS_FILE, chatId);
      await send(chatId, [plainLine("🆕 Fresh conversation. Model and persona are unchanged.")]);
      return true;
    case "status":
      await handleStatus(config, chatId);
      return true;
    case "model":
      await handleModel(config, chatId, args);
      return true;
    case "persona":
      await handlePersona(config, chatId, args);
      return true;
    case "mode":
      await handleMode(config, chatId, args);
      return true;
    case "tz":
      await handleTz(config, chatId, args);
      return true;
    default:
      // Not one of ours: let it through as an ordinary message rather than
      // rejecting it, since a person can legitimately start a sentence with a
      // slash and would otherwise get a lecture instead of an answer.
      return false;
  }
}

// --- Inbound --------------------------------------------------------------

/**
 * Turn an inbound message into the prompt the agent sees.
 *
 * Attachments are handed over as paths rather than bytes: Jazz ingests media by
 * path, and an iMessage attachment is already a local file, so there is nothing
 * to download — which is the one thing this bridge has easier than the others.
 */
function promptFrom(message: ImsgMessage): string {
  const parts: string[] = [];
  if (message.replyToText !== undefined) {
    parts.push(`[replying to: ${message.replyToText}]`);
  }
  if (message.text.trim().length > 0) parts.push(message.text.trim());
  for (const attachment of message.attachments) {
    if (attachment.missing) continue;
    parts.push(attachment.convertedPath ?? attachment.originalPath);
  }
  return parts.join("\n");
}

async function handleIncoming(config: BridgeConfig, message: ImsgMessage): Promise<void> {
  // Our own replies come back through the same watch stream; answering them
  // would be an unbounded loop with a person watching.
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

  const state = stateFor(message.chatId);

  // `busy` is set synchronously below and is what serialises a chat. Keying
  // this on `state.run` instead would leave a window: every message handler
  // runs concurrently, and a second message arriving while the first is still
  // in the awaits before the run is spawned would start a second run against
  // the same conversation.
  if (state.busy) {
    if (await resolvePending(message.chatId, prompt)) return;
    state.queue.push(prompt);
    return;
  }

  state.busy = true;
  try {
    let next: string | undefined = prompt;
    while (next !== undefined) {
      if (!(await handleCommand(config, message.chatId, next))) {
        await answer(config, message.chatId, next);
      }
      // Anything that arrived while that ran is answered now, in order.
      next = state.queue.shift();
    }
  } finally {
    state.busy = false;
  }
}

// --- Startup --------------------------------------------------------------

async function start(): Promise<void> {
  const config = loadConfig();

  const availability = await checkImsg(config.imsgBinary);
  if (!availability.available) {
    console.error(availability.reason);
    process.exit(1);
  }

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
    send: (chatId, body) => surface.send(chatId, { body }),
  });

  const watcher = watchMessages({
    binary: config.imsgBinary,
    sinceRowId: readCursor(config.jazzHome),
    includeAttachments: true,
    onRestart: (reason) => console.error(`${reason}; restarting the watcher.`),
    onMessage: (message) => {
      writeCursor(config.jazzHome, message.id);
      void handleIncoming(config, message).catch((error) =>
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

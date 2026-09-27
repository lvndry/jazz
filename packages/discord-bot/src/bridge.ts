/**
 * Discord → Jazz bridge.
 *
 * Gateway websocket in, the shared turn runner (`@jazz/bot-shared/turn`) from there: one run
 * at a time per conversation, the edited progress message with ⏹ Cancel, approvals with
 * Approve all, questions, the command set and its pickers, reminders, incognito, and the
 * answer. What is here is what only Discord has: the gateway and REST transport, who is
 * allowed in and when a guild message counts as addressed to the bot, binding a mention to
 * a thread, slash commands, acknowledging interactions inside Discord's three seconds,
 * inbound attachments, and the contextual suggestion buttons under an answer.
 *
 * Per-channel memory and model/persona live in the channel's own agent (`dc_<channel id>`).
 * Guild channels are mention-gated and, by default, bound to a thread so one conversation
 * doesn't swallow the whole room.
 *
 * Runs on Bun. All configuration is via environment variables (see .env.example).
 */

import { envFlag } from "@jazz/bot-shared/bridge-env";
import { ensureChatSandbox, SANDBOX_UMASK, sandboxOwnership } from "@jazz/bot-shared/chat-sandbox";
import {
  compositionIdFromPath,
  type CompositionLinks,
  createCompositionLinks,
} from "@jazz/bot-shared/compositions";
import {
  createSuggestionStore,
  generateSuggestions,
  removeSuggestAgents,
  SUGGESTION_PROMPT_PREFIX,
} from "@jazz/bot-shared/dynamic-suggestions";
import { createHealthState, type HealthState, healthResponse } from "@jazz/bot-shared/health";
import { saveInboundMedia } from "@jazz/bot-shared/inbound-media";
import { inboundMediaFileName } from "@jazz/bot-shared/media-name";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { answerRunFromChat, isRunAnswerCommand } from "@jazz/bot-shared/run-answer";
import { ensureSeedAgent } from "@jazz/bot-shared/seed-agent";
import { installShutdown } from "@jazz/bot-shared/shutdown";
import { line, plainLine, subtle, text } from "@jazz/bot-shared/surface";
import {
  type ChoiceOutcome,
  createTurnRunner,
  type TurnConfig,
  type TurnRunner,
} from "@jazz/bot-shared/turn";
import { parseCommand } from "@jazz/bot-shared/turn-commands";
import {
  type AccessConfig,
  hasAnyAllowlist,
  isSenderAllowed,
  messageMentionsUser,
  parseSnowflakeList,
  shouldRespond,
  stripBotMention,
} from "./access";
import {
  agentIdForChannel,
  channelIdFromAgentId,
  hasChatAgent,
  syncAgentDisplayName,
} from "./agents";
import {
  bulkOverwriteGlobalCommands,
  bulkOverwriteGuildCommands,
  CALLBACK_DEFERRED_CHANNEL_MESSAGE,
  CALLBACK_DEFERRED_UPDATE,
  CHANNEL_TYPE_DM,
  CHANNEL_TYPE_GROUP_DM,
  connectGateway,
  createThreadFromMessage,
  deleteOriginalInteraction,
  type DiscordAttachment,
  type DiscordInteraction,
  type DiscordMessage,
  ephemeralFollowup,
  getChannel,
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_MESSAGE_COMPONENT,
  INTERACTION_PING,
  interactionCallback,
  interactionUserId,
  isRespondableMessage,
  isThreadChannelType,
  type SlashCommand,
} from "./discord";
import { threadNameFromPrompt } from "./discord-md";
import { createDiscordSurface, type DiscordSurface } from "./surface";

const STORE_FILES = {
  timezone: "dc-tz.json",
  sessions: "dc-sessions.json",
  mode: "dc-mode.json",
} as const;
const INCOGNITO_FILE = "dc-incognito.json";
const COMPOSITIONS_FILE = "dc-compositions.json";
const SUGGEST_AGENT_ID = "dc_suggest";
const MEDIA_DIRECTORY = "dc-media";

/** Discord's own spoiler blocks carry the reasoning, so it can afford a few parts. */
const REASONING_PART_CHARS = 1_700;
const REASONING_MAX_PARTS = 4;

/**
 * Largest attachment downloaded for the agent. Discord's default upload cap for a server
 * without boosts; a larger file is refused with a message rather than fetched.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Discord asks for a heartbeat about every 41 seconds and acknowledges each one, so a
 * working gateway beats at least that often. Three missed acknowledgements is a gateway
 * that is not getting through.
 */
const GATEWAY_STALE_AFTER_MS = 3 * 45_000;

interface ChannelMeta {
  readonly type: number;
  readonly parentId: string | undefined;
  readonly guildId: string | undefined;
}

export interface BridgeConfig extends AccessConfig {
  readonly botToken: string;
  /**
   * Discord user ids allowed to widen a conversation's authority (`/mode yolo`). Being
   * allowed to talk to the bot is not enough: with a guild allowlist that is the whole
   * server.
   */
  readonly operatorIds: ReadonlySet<string>;
  readonly createThreads: boolean;
  readonly baseAgentId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly builtinPersonasDir: string;
  readonly port: number;
  readonly dailyCostCapUsd: number;
  readonly dynamicCta: boolean;
  /** Attach the run's full reasoning under the answer as click-to-reveal spoilers. */
  readonly showReasoning: boolean;
  readonly publicBaseUrl: string | undefined;
}

interface Runtime {
  botUserId: string;
  applicationId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function loadConfig(): BridgeConfig {
  const allowedUserIds = parseSnowflakeList(process.env["DISCORD_ALLOWED_USER_IDS"] ?? "");
  const allowedChannelIds = parseSnowflakeList(process.env["DISCORD_ALLOWED_CHANNEL_IDS"] ?? "");
  const allowedGuildIds = parseSnowflakeList(process.env["DISCORD_ALLOWED_GUILD_IDS"] ?? "");

  if (
    !hasAnyAllowlist({
      allowedUserIds,
      allowedChannelIds,
      allowedGuildIds,
      requireMention: true,
    })
  ) {
    throw new Error(
      "Set DISCORD_ALLOWED_USER_IDS, DISCORD_ALLOWED_CHANNEL_IDS, and/or DISCORD_ALLOWED_GUILD_IDS " +
        "so the bot only answers people you chose.",
    );
  }

  return {
    botToken: requireEnv("DISCORD_BOT_TOKEN"),
    operatorIds: parseSnowflakeList(process.env["DISCORD_OPERATOR_IDS"] ?? ""),
    allowedUserIds,
    allowedChannelIds,
    allowedGuildIds,
    requireMention: envFlag("DISCORD_REQUIRE_MENTION", true),
    createThreads: envFlag("DISCORD_CREATE_THREADS", true),
    baseAgentId: process.env["JAZZ_DISCORD_AGENT"]?.trim() || "discord",
    provider: process.env["JAZZ_DISCORD_PROVIDER"]?.trim() || "openai",
    model: process.env["JAZZ_DISCORD_MODEL"]?.trim() || "gpt-5.4",
    reasoning: process.env["JAZZ_REASONING"]?.trim() || "medium",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || "jazz",
    jazzHome: process.env["JAZZ_HOME"]?.trim() || "/data",
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "/opt/jazz/personas",
    port: Number.parseInt(process.env["PORT"]?.trim() || "8080", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    dynamicCta: envFlag("JAZZ_DISCORD_DYNAMIC_CTA", true),
    showReasoning: envFlag("JAZZ_DISCORD_SHOW_REASONING", true),
    publicBaseUrl: process.env["DISCORD_PUBLIC_BASE_URL"]?.trim() || undefined,
  };
}

/** Everything the gateway handlers need, built once at start. */
export interface Bridge {
  readonly config: BridgeConfig;
  readonly health: HealthState;
  readonly surface: DiscordSurface;
  readonly runner: TurnRunner;
  readonly compositions: CompositionLinks;
  /** Channel id → what the access decision needs about it. */
  readonly channels: Map<string, ChannelMeta>;
  /** Looks a channel up over REST on a cache miss. A seam for tests. */
  readonly fetchChannel: (channelId: string) => Promise<ChannelMeta>;
}

async function resolveChannel(bridge: Bridge, channelId: string): Promise<ChannelMeta> {
  const cached = bridge.channels.get(channelId);
  if (cached !== undefined) return cached;
  const meta = await bridge.fetchChannel(channelId);
  bridge.channels.set(channelId, meta);
  return meta;
}

// --- Slash commands -------------------------------------------------------

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Model, today's usage, uptime" },
  { name: "new", description: "Start a fresh conversation (clears earlier context)" },
  { name: "incognito", description: "Start a private conversation (nothing saved) until /new" },
  {
    name: "model",
    description: "Pick a model for the current provider (send /model provider/model to switch)",
  },
  { name: "persona", description: "Pick my persona / style" },
  {
    name: "mode",
    description: "Safe (ask before risky tools) or yolo (never ask; operators only)",
    options: [
      {
        name: "mode",
        description: "Leave empty to see the current mode and pick from buttons",
        type: 3,
        choices: [
          { name: "safe", value: "safe" },
          { name: "yolo", value: "yolo" },
        ],
      },
    ],
  },
  { name: "reminders", description: "List and cancel your reminders" },
  {
    name: "tz",
    description: "Show or set your timezone",
    options: [{ name: "zone", description: "IANA timezone, e.g. Europe/Paris", type: 3 }],
  },
  {
    name: "remind",
    description: "Set a reminder",
    options: [
      {
        name: "when",
        description: "30m, 1h, 18:00, tomorrow 09:00, tue 20:00, 2026-08-25 20:00",
        type: 3,
        required: true,
      },
      { name: "text", description: "What to remind you about", type: 3, required: true },
    ],
  },
];

function slashOption(interaction: DiscordInteraction, name: string): string | undefined {
  const match = (interaction.data?.options ?? []).find((option) => option.name === name);
  return typeof match?.value === "string" ? match.value : undefined;
}

/** A slash command as the text command the runner already understands. */
export function slashCommandText(interaction: DiscordInteraction): string {
  const name = interaction.data?.name ?? "help";
  const args =
    name === "remind"
      ? `${slashOption(interaction, "when") ?? ""} ${slashOption(interaction, "text") ?? ""}`
      : name === "tz"
        ? (slashOption(interaction, "zone") ?? "")
        : name === "mode"
          ? (slashOption(interaction, "mode") ?? "")
          : "";
  return `/${name} ${args}`.trim();
}

// --- Access ---------------------------------------------------------------

function accessContextForMessage(
  bridge: Bridge,
  message: DiscordMessage,
  meta: ChannelMeta,
  botUserId: string,
): Parameters<typeof isSenderAllowed>[1] {
  const isThread = isThreadChannelType(meta.type);
  return {
    isDm: meta.type === CHANNEL_TYPE_DM,
    isThread,
    userId: message.author.id,
    channelId: message.channel_id,
    parentChannelId: meta.parentId,
    guildId: message.guild_id ?? meta.guildId,
    mentionedBot:
      messageMentionsUser(message.content, botUserId) ||
      (message.mentions ?? []).some((user) => user.id === botUserId),
    replyToBot: message.referenced_message?.author?.id === botUserId,
    threadHasSession: isThread && hasChatAgent(bridge.config.jazzHome, message.channel_id),
  };
}

function senderAllowedForInteraction(
  bridge: Bridge,
  interaction: DiscordInteraction,
  meta: ChannelMeta,
): boolean {
  const userId = interactionUserId(interaction);
  if (userId === undefined) return false;
  const isThread = isThreadChannelType(meta.type);
  return isSenderAllowed(bridge.config, {
    isDm: meta.type === CHANNEL_TYPE_DM || interaction.guild_id === undefined,
    isThread,
    userId,
    channelId: interaction.channel_id ?? "",
    parentChannelId: meta.parentId,
    guildId: interaction.guild_id ?? meta.guildId,
    mentionedBot: true,
    replyToBot: false,
    threadHasSession:
      isThread && hasChatAgent(bridge.config.jazzHome, interaction.channel_id ?? ""),
  });
}

async function bindThreadIfNeeded(
  bridge: Bridge,
  message: DiscordMessage,
  meta: ChannelMeta,
  prompt: string,
): Promise<string> {
  const isThread = isThreadChannelType(meta.type);
  if (meta.type === CHANNEL_TYPE_DM || isThread || !bridge.config.createThreads) {
    return message.channel_id;
  }
  const thread = await createThreadFromMessage(
    bridge.config.botToken,
    message.channel_id,
    message.id,
    threadNameFromPrompt(prompt),
  );
  if (thread === undefined) return message.channel_id;
  bridge.channels.set(thread.id, {
    type: thread.type,
    parentId: message.channel_id,
    guildId: message.guild_id ?? meta.guildId,
  });
  return thread.id;
}

// --- Attachments ----------------------------------------------------------

/**
 * Download a message's attachments into the conversation's home and return their paths,
 * plus a line for each one that could not be fetched.
 */
async function saveAttachments(
  bridge: Bridge,
  channelId: string,
  attachments: readonly DiscordAttachment[],
): Promise<{ readonly paths: string[]; readonly failures: string[] }> {
  const sandbox = ensureChatSandbox(bridge.config.jazzHome, agentIdForChannel(channelId));
  const paths: string[] = [];
  const failures: string[] = [];
  for (const attachment of attachments) {
    if (typeof attachment.size === "number" && attachment.size > MAX_ATTACHMENT_BYTES) {
      failures.push(`${attachment.filename} is over 25 MB`);
      continue;
    }
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        failures.push(`${attachment.filename} (download failed with ${response.status})`);
        continue;
      }
      paths.push(
        saveInboundMedia({
          home: sandbox.home,
          directoryName: MEDIA_DIRECTORY,
          fileName: inboundMediaFileName(
            attachment.id,
            attachment.filename,
            attachment.content_type,
          ),
          bytes: new Uint8Array(await response.arrayBuffer()),
          ownership: sandboxOwnership(sandbox),
          nowMs: Date.now(),
        }),
      );
    } catch (error) {
      failures.push(`${attachment.filename} (${String(error)})`);
    }
  }
  return { paths, failures };
}

// --- Dispatch -------------------------------------------------------------

export async function dispatchMessage(
  bridge: Bridge,
  runtime: Runtime,
  message: DiscordMessage,
): Promise<void> {
  if (message.author.id === runtime.botUserId) return;
  if (message.author.bot === true) return;
  if (!isRespondableMessage(message)) return;

  const meta = await resolveChannel(bridge, message.channel_id);
  if (meta.type === CHANNEL_TYPE_GROUP_DM) return;

  const context = accessContextForMessage(bridge, message, meta, runtime.botUserId);
  if (!isSenderAllowed(bridge.config, context)) {
    console.warn(
      `Ignoring message from non-allowed user ${message.author.id} in ${message.channel_id}`,
    );
    return;
  }
  if (
    !shouldRespond(bridge.config, context) &&
    !bridge.runner.awaitsReplyFrom(message.channel_id, message.author.id)
  ) {
    return;
  }

  const attachments = message.attachments ?? [];
  const stripped = stripBotMention(message.content, runtime.botUserId);
  if (stripped.length === 0 && attachments.length === 0) {
    if (context.mentionedBot && message.content.trim().length === 0) {
      await bridge.runner.send(message.channel_id, [
        line(
          text(
            "I can see you mentioned me but not the text — enable the Message Content Intent for this bot in the Discord developer portal.",
          ),
        ),
      ]);
    }
    return;
  }

  const parsed = parseCommand(stripped);
  if (parsed !== undefined && isRunAnswerCommand(parsed.command)) {
    const reply = await answerRunFromChat({
      command: parsed.command,
      args: parsed.args,
      senderId: message.author.id,
      operatorIds: bridge.config.operatorIds,
      operatorSettingName: "DISCORD_OPERATOR_IDS",
      jazzBinary: bridge.config.jazzBinary,
      onAccepted: (runId) =>
        bridge.runner.send(message.channel_id, [plainLine(`⏳ Answering run ${runId}…`)]),
    });
    await bridge.runner.send(message.channel_id, [plainLine(reply)]);
    return;
  }

  try {
    const channelId = await bindThreadIfNeeded(bridge, message, meta, stripped || "attachment");
    const { paths, failures } = await saveAttachments(bridge, channelId, attachments);
    if (failures.length > 0) {
      await bridge.runner.send(channelId, [
        plainLine(`⚠️ I couldn't fetch ${failures.join(", ")}.`),
      ]);
    }
    const prompt = [stripped || (paths.length > 0 ? "Look at this." : ""), ...paths]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (prompt.length === 0) return;
    await bridge.runner.handle({ chatId: channelId, senderId: message.author.id, text: prompt });
  } catch (error) {
    console.error(`Handling failed for ${message.channel_id}: ${String(error)}`);
    await bridge.runner
      .send(message.channel_id, [plainLine("⚠️ Something went wrong handling your message.")])
      .catch((replyError) =>
        console.error(`Failed to notify ${message.channel_id}: ${String(replyError)}`),
      );
  }
}

const suggestions = createSuggestionStore();

/** What the clicker is told, when their click did not simply work. */
function noticeFor(outcome: ChoiceOutcome, userId: string): string | undefined {
  switch (outcome) {
    case "answered":
      return undefined;
    case "expired":
      return "This already expired or the run finished.";
    case "not-requester":
      return "Only the person who asked can answer this.";
    case "not-operator":
      return `Only this bot's operator can do that. Your id is \`${userId}\`; the operator adds it to \`DISCORD_OPERATOR_IDS\`.`;
  }
}

async function handleSuggestionClick(
  bridge: Bridge,
  channelId: string,
  userId: string,
  messageId: string,
  token: string,
  choiceId: string,
): Promise<ChoiceOutcome> {
  const item = suggestions.get(token)?.[Number.parseInt(choiceId, 10)];
  if (item === undefined) return "expired";
  await bridge.surface.setChoices(channelId, messageId, []);
  // A bot cannot post as the clicker, so the echo is attributed subtext rather than a
  // plain line that reads as the bot talking to itself.
  await bridge.surface.send(channelId, {
    body: [subtle(text(`<@${userId}> · ${item.label}`))],
    replyTo: messageId,
  });
  void bridge.runner
    .handle({ chatId: channelId, senderId: userId, text: item.prompt, replyTo: messageId })
    .catch((error: unknown) => console.error(`Suggestion follow-up failed: ${String(error)}`));
  return "answered";
}

/**
 * A click on a button or select menu.
 *
 * Acknowledged first, before anything that can take time (a channel lookup, a model list, a
 * run): Discord fails the interaction after three seconds without one. Anything the clicker
 * needs to be told afterwards goes as an ephemeral follow-up.
 */
export async function dispatchComponent(
  bridge: Bridge,
  interaction: DiscordInteraction,
): Promise<void> {
  await interactionCallback(interaction.id, interaction.token, {
    type: CALLBACK_DEFERRED_UPDATE,
  });
  const notify = (content: string): Promise<void> =>
    ephemeralFollowup(interaction.application_id, interaction.token, content);

  const channelId = interaction.channel_id ?? interaction.message?.channel_id;
  const messageId = interaction.message?.id;
  const userId = interactionUserId(interaction);
  if (channelId === undefined || messageId === undefined || userId === undefined) return;

  const meta = await resolveChannel(bridge, channelId);
  if (!senderAllowedForInteraction(bridge, interaction, meta)) {
    await notify("You're not on the allowlist for this bot.");
    return;
  }

  // A select menu's picked value is the token; a button's is its custom id.
  const payload = interaction.data?.values?.[0] ?? interaction.data?.custom_id ?? "";
  const choice = bridge.surface.readChoice(payload);
  let outcome: ChoiceOutcome;
  if (choice === undefined) {
    // Components drawn before a restart, or by an earlier version of the bridge.
    outcome = "expired";
  } else if (choice.promptId.startsWith(SUGGESTION_PROMPT_PREFIX)) {
    outcome = await handleSuggestionClick(
      bridge,
      channelId,
      userId,
      messageId,
      choice.promptId.slice(SUGGESTION_PROMPT_PREFIX.length),
      choice.choiceId,
    );
  } else {
    outcome = await bridge.runner.deliverChoice({
      chatId: channelId,
      promptId: choice.promptId,
      choiceId: choice.choiceId,
      senderId: userId,
      messageRef: messageId,
    });
  }
  const notice = noticeFor(outcome, userId);
  if (notice !== undefined) await notify(notice);
}

/**
 * A slash command, handed to the runner as the text command it stands for.
 *
 * Deferred first, inside Discord's three seconds; the runner then answers in the channel
 * like any other command, and the deferred placeholder is removed once it has.
 */
export async function dispatchSlash(
  bridge: Bridge,
  interaction: DiscordInteraction,
): Promise<void> {
  await interactionCallback(interaction.id, interaction.token, {
    type: CALLBACK_DEFERRED_CHANNEL_MESSAGE,
    data: { flags: 64 },
  });
  const channelId = interaction.channel_id;
  const userId = interactionUserId(interaction);
  if (channelId === undefined || userId === undefined) {
    await ephemeralFollowup(
      interaction.application_id,
      interaction.token,
      "I need a channel to reply in.",
    );
    return;
  }
  const meta = await resolveChannel(bridge, channelId);
  if (!senderAllowedForInteraction(bridge, interaction, meta)) {
    await ephemeralFollowup(
      interaction.application_id,
      interaction.token,
      "You're not on the allowlist for this bot.",
    );
    return;
  }
  const turn = bridge.runner.handle({
    chatId: channelId,
    senderId: userId,
    text: slashCommandText(interaction),
  });
  // A command answers in a moment; one that starts a run (/remind) is shown by its own
  // progress message, so the placeholder goes as soon as the reply is under way.
  await Promise.race([turn, Bun.sleep(1_000)]);
  await deleteOriginalInteraction(interaction.application_id, interaction.token);
  await turn;
}

export async function dispatchInteraction(
  bridge: Bridge,
  interaction: DiscordInteraction,
): Promise<void> {
  if (interaction.type === INTERACTION_PING) {
    await interactionCallback(interaction.id, interaction.token, { type: 1 });
    return;
  }
  if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
    await dispatchSlash(bridge, interaction);
    return;
  }
  if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
    await dispatchComponent(bridge, interaction);
  }
}

function startHealthServer(bridge: Bridge): void {
  Bun.serve({
    port: bridge.config.port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return healthResponse(bridge.health);
      }
      const compositionId =
        request.method === "GET" ? compositionIdFromPath(url.pathname) : undefined;
      if (compositionId !== undefined) {
        const page = bridge.compositions.page(compositionId);
        return page === undefined
          ? new Response("not found", { status: 404 })
          : new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Health server listening on :${bridge.config.port}`);
}

/**
 * Wire the surface, the runner and the web-app store together for one configuration.
 *
 * `startRun` and `fetchChannel` are test seams: substitutes for spawning `jazz run` and for
 * looking a channel up over REST.
 */
export function createBridge(
  config: BridgeConfig,
  surface: DiscordSurface,
  seams: {
    readonly startRun?: TurnConfig["startRun"];
    readonly fetchChannel?: (channelId: string) => Promise<ChannelMeta>;
  } = {},
): Bridge {
  const compositions = createCompositionLinks(config.jazzHome, COMPOSITIONS_FILE);
  const runner = createTurnRunner({
    surface,
    ...(seams.startRun === undefined ? {} : { startRun: seams.startRun }),
    jazzBinary: config.jazzBinary,
    jazzHome: config.jazzHome,
    baseAgentId: config.baseAgentId,
    builtinPersonasDir: config.builtinPersonasDir,
    approvalPolicy: config.approvalPolicy,
    autoApproveTools: config.autoApproveTools,
    runTimeoutMs: config.runTimeoutMs,
    dailyCostCapUsd: config.dailyCostCapUsd,
    showReasoning: config.showReasoning,
    reasoningPartChars: REASONING_PART_CHARS,
    reasoningMaxParts: REASONING_MAX_PARTS,
    files: STORE_FILES,
    spendOrigin: "discord",
    incognitoFile: INCOGNITO_FILE,
    agentIdFor: agentIdForChannel,
    operators: config.operatorIds,
    operatorSettingName: "DISCORD_OPERATOR_IDS",
    ...(config.publicBaseUrl === undefined
      ? {}
      : { compositionServer: { publicBaseUrl: config.publicBaseUrl, links: compositions } }),
    publicUrlSettingName: "DISCORD_PUBLIC_BASE_URL",
    extraHelp: [
      "/approve <runId>, /deny <runId> [why]: answer a parked run (operator only)",
      "",
      "In a server I only reply when mentioned, when you reply to me, or in a thread I already joined.",
    ],
    ...(config.dynamicCta
      ? {
          onAnswered: async (turn) => {
            if (turn.messageRef === undefined) return;
            const items = await generateSuggestions({
              jazzBinary: config.jazzBinary,
              jazzHome: config.jazzHome,
              baseAgentId: config.baseAgentId,
              suggestAgentId: SUGGEST_AGENT_ID,
              surfaceName: surface.name,
              sandbox: ensureChatSandbox(config.jazzHome, agentIdForChannel(turn.chatId)),
              question: turn.question,
              answer: turn.answer,
            });
            console.log(`[cta] channel ${turn.chatId}: ${items.length} contextual suggestion(s)`);
            // Keep the static follow-ups already attached when the model gave nothing.
            if (items.length === 0) return;
            const token = suggestions.put(items);
            await surface.setChoices(
              turn.chatId,
              turn.messageRef,
              items.map((item, index) => ({ id: String(index), label: item.label })),
              `${SUGGESTION_PROMPT_PREFIX}${token}`,
            );
          },
        }
      : {}),
  });
  return {
    config,
    surface,
    runner,
    compositions,
    health: createHealthState(GATEWAY_STALE_AFTER_MS),
    channels: new Map(),
    fetchChannel:
      seams.fetchChannel ??
      (async (channelId) => {
        const fetched = await getChannel(config.botToken, channelId);
        return {
          type: fetched?.type ?? 0,
          parentId: fetched?.parent_id ?? undefined,
          guildId: fetched?.guild_id,
        };
      }),
  };
}

export function startBridge(): void {
  const config = loadConfig();
  // Everything this process and its agents write stays off-limits to anyone outside the
  // operator group — the data directory is shared with whoever else is on the host.
  process.umask(SANDBOX_UMASK);

  if (
    ensureSeedAgent(config.jazzHome, {
      id: config.baseAgentId,
      name: "Jazz",
      description: "Everyday assistant reachable from Discord.",
      provider: config.provider,
      model: config.model,
      reasoning: config.reasoning,
    })
  ) {
    console.log(
      `Seeded agent '${config.baseAgentId}' (${config.provider}/${config.model}, ` +
        `reasoning=${config.reasoning}) into ${config.jazzHome}/agents`,
    );
  }
  removeSuggestAgents(config.jazzHome, SUGGEST_AGENT_ID);

  const bridge = createBridge(config, createDiscordSurface({ botToken: config.botToken }));
  startHealthServer(bridge);
  startReminderSweep({
    dataDir: config.jazzHome,
    decodeScope: (agentId) => channelIdFromAgentId(agentId) ?? undefined,
    send: (channelId, body) => bridge.runner.send(channelId, body),
  });

  let runtime: Runtime | undefined;

  const gateway = connectGateway(config.botToken, {
    onHealthy: () => bridge.health.beat(),
    onFatal: (code, why) => bridge.health.fail(`gateway closed with ${code}: ${why}`),
    onReady(info) {
      runtime = { botUserId: info.userId, applicationId: info.applicationId };
      syncAgentDisplayName(config.jazzHome, config.baseAgentId, info.username);
      console.log(
        `Discord → Jazz bridge ready as @${info.username} (${info.userId}), policy="${config.approvalPolicy}"`,
      );
      void bulkOverwriteGlobalCommands(config.botToken, info.applicationId, SLASH_COMMANDS).catch(
        (error) => console.error(`Failed to register global commands: ${String(error)}`),
      );
    },
    onGuildCreate(guildId) {
      const applicationId = runtime?.applicationId;
      if (applicationId === undefined) return;
      void bulkOverwriteGuildCommands(
        config.botToken,
        applicationId,
        guildId,
        SLASH_COMMANDS,
      ).catch((error) =>
        console.error(`Failed to register guild commands for ${guildId}: ${String(error)}`),
      );
    },
    onMessage(message) {
      if (runtime === undefined) return;
      void dispatchMessage(bridge, runtime, message);
    },
    onInteraction(interaction) {
      void dispatchInteraction(bridge, interaction).catch((error) =>
        console.error(`Interaction handling failed: ${String(error)}`),
      );
    },
  });

  installShutdown({ runner: bridge.runner, stopIntake: () => gateway.stop() });
}

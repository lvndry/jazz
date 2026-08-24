/**
 * Discord → Jazz bridge.
 *
 * Gateway websocket in, `jazz run --json` out. Per-channel memory comes from
 * `--conversation`; per-channel model/persona from a cloned agent file
 * (`dc_<channel_id>.json`). Guild channels are mention-gated and, by default,
 * bound to a thread so one conversation doesn't swallow the whole room.
 *
 * Runs on Bun. All configuration is via environment variables (see .env.example).
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import type { ReminderRecord } from "@/core/interfaces/reminder-service";
import { ReminderServiceImpl } from "@/services/reminder-service";
import {
  type AccessConfig,
  hasAnyAllowlist,
  isSenderAllowed,
  messageMentionsUser,
  parseCommand,
  parseSnowflakeList,
  shouldRespond,
  stripBotMention,
} from "./access";
import {
  agentIdForChannel,
  agentPath,
  ensureChatAgent,
  hasChatAgent,
  readAgentFile,
  syncAgentDisplayName,
  writeAgentFile,
} from "./agents";
import {
  actionRow,
  BUTTON_DANGER,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  type DiscordInteraction,
  type DiscordMessage,
  bulkOverwriteGlobalCommands,
  bulkOverwriteGuildCommands,
  button,
  CALLBACK_CHANNEL_MESSAGE,
  CALLBACK_DEFERRED_CHANNEL_MESSAGE,
  CALLBACK_DEFERRED_UPDATE,
  CALLBACK_UPDATE_MESSAGE,
  CHANNEL_TYPE_DM,
  CHANNEL_TYPE_GROUP_DM,
  connectGateway,
  createThreadFromMessage,
  editMessage,
  editOriginalInteraction,
  FLAG_EPHEMERAL,
  getChannel,
  getOriginalInteraction,
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_MESSAGE_COMPONENT,
  INTERACTION_PING,
  interactionCallback,
  interactionUserId,
  isRespondableMessage,
  isThreadChannelType,
  patchMessage,
  sendAttachment,
  sendMessage,
  stringSelect,
  triggerTyping,
  type SlashCommand,
} from "./discord";
import {
  neutralizeBroadcastMentions,
  spoilerBlock,
  splitForDiscord,
  threadNameFromPrompt,
} from "./discord-md";
import { startReminderSweep } from "./reminders";
import { conversationKey, isIncognito, setIncognito, startNewConversation } from "./sessions";
import { formatWhen, hasChatTz, isValidTimeZone, setTzForChat, tzForChat } from "./timezone";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage";
import { reasoningSnippet, splitReasoning } from "../shared/reasoning";

const PROGRESS_MIN_INTERVAL_MS = 2_000;
const PROGRESS_MAX_TOOLS_SHOWN = 8;
// The reasoning log goes out inside a spoiler, which costs four characters;
// budget under the 1900 the answer splitter uses so a part plus its heading
// stays clear of Discord's 2000 hard limit without splitting mid-spoiler.
const REASONING_PART_CHARS = 1_700;
// A long agentic run would otherwise post a wall of spoilers; past this the
// tail is dropped and the final part says how much.
const REASONING_MAX_PARTS = 4;
const BRIDGE_STARTED_AT = Date.now();

const activeRuns = new Map<
  string,
  { child: Bun.Subprocess<"pipe", "pipe", "pipe">; cancelled: boolean }
>();
const pendingApprovals = new Map<
  string,
  { toolCallId: string; channelId: string; messageId: string; runToken: string }
>();
const incognitoHistory = new Map<string, unknown[]>();

interface ChannelMeta {
  readonly type: number;
  readonly parentId: string | undefined;
  readonly guildId: string | undefined;
}

const channelCache = new Map<string, ChannelMeta>();

interface BridgeConfig extends AccessConfig {
  readonly botToken: string;
  readonly createThreads: boolean;
  readonly baseAgentId: string;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly ollamaBaseUrl: string;
  readonly builtinPersonasDir: string;
  readonly port: number;
  readonly dailyCostCapUsd: number;
  readonly dynamicCta: boolean;
  /**
   * Attach the run's full reasoning under the answer as click-to-reveal
   * spoilers. The live progress line only ever shows a rolling tail, and that
   * message is overwritten when the answer lands.
   */
  readonly showReasoning: boolean;
  readonly publicBaseUrl: string | undefined;
}

interface JazzWebApp {
  readonly id: string;
  readonly mode: "static" | "interactive";
  readonly title: string;
  readonly htmlPath: string;
  readonly imagePath?: string;
}

interface JazzSuccessEnvelope {
  readonly ok: true;
  readonly answer: string;
  readonly costUSD: number;
  readonly costKnown?: boolean;
  readonly tokenUsage?: {
    readonly totalTokens?: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly cacheReadTokens?: number;
  };
  readonly webApp?: JazzWebApp;
  readonly messages?: unknown[];
}

interface JazzErrorEnvelope {
  readonly ok: false;
  readonly error: string;
}

type JazzEnvelope = JazzSuccessEnvelope | JazzErrorEnvelope;

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

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
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
    allowedUserIds,
    allowedChannelIds,
    allowedGuildIds,
    requireMention: envFlag("DISCORD_REQUIRE_MENTION", true),
    createThreads: envFlag("DISCORD_CREATE_THREADS", true),
    baseAgentId: process.env["JAZZ_DISCORD_AGENT"]?.trim() || "discord",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || "jazz",
    jazzHome: process.env["JAZZ_HOME"]?.trim() || "/data",
    ollamaBaseUrl: process.env["OLLAMA_BASE_URL"]?.trim() || "http://localhost:11434/api",
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "/opt/jazz/personas",
    port: Number.parseInt(process.env["PORT"]?.trim() || "8080", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    dynamicCta: envFlag("JAZZ_DISCORD_DYNAMIC_CTA", true),
    showReasoning: envFlag("JAZZ_DISCORD_SHOW_REASONING", true),
    publicBaseUrl: process.env["DISCORD_PUBLIC_BASE_URL"]?.trim() || undefined,
  };
}

function webAppsDirectory(config: BridgeConfig): string {
  return `${config.jazzHome}/webapps`;
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function newRunToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * Input and output split out, since a single total hides that the input is
 * the whole conversation plus tool schemas re-sent on every loop iteration.
 */
function formatUsageLines(usage: JazzSuccessEnvelope["tokenUsage"]): string | undefined {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return undefined;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cached = cacheReadTokens > 0 ? ` (${formatTokenCount(cacheReadTokens)} cached)` : "";
  return [
    `-# Input: ${formatTokenCount(promptTokens)}${cached}`,
    `-# Output: ${formatTokenCount(completionTokens)}`,
  ].join("\n");
}

async function resolveChannel(config: BridgeConfig, channelId: string): Promise<ChannelMeta> {
  const cached = channelCache.get(channelId);
  if (cached !== undefined) return cached;
  const fetched = await getChannel(config.botToken, channelId);
  const meta: ChannelMeta = {
    type: fetched?.type ?? 0,
    parentId: fetched?.parent_id ?? undefined,
    guildId: fetched?.guild_id,
  };
  channelCache.set(channelId, meta);
  return meta;
}

function rememberChannel(channelId: string, meta: ChannelMeta): void {
  channelCache.set(channelId, meta);
}

async function sendReply(
  config: BridgeConfig,
  channelId: string,
  text: string,
  extras: Record<string, unknown> = {},
): Promise<string | undefined> {
  const chunks = splitForDiscord(neutralizeBroadcastMentions(text));
  let lastId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const sent = await sendMessage(config.botToken, channelId, chunk, isLast ? extras : {});
    lastId = sent?.id ?? lastId;
  }
  return lastId;
}

function cancelComponents(runToken: string): unknown[] {
  return [actionRow([button(`x:${runToken}`, "⏹ Cancel", BUTTON_DANGER)])];
}

function approvalComponents(token: string): unknown[] {
  return [
    actionRow([
      button(`a:${token}:1`, "✅ Accept", BUTTON_SUCCESS),
      button(`a:${token}:0`, "❌ Reject", BUTTON_DANGER),
    ]),
  ];
}

function followupComponents(): unknown[] {
  const buttons = Object.entries(FOLLOWUP_OPTIONS).map(([key, option]) =>
    button(`f:${key}`, option.label, BUTTON_SECONDARY),
  );
  const rows: unknown[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(actionRow(buttons.slice(index, index + 5)));
  }
  return rows;
}

interface JazzEvent {
  readonly type: string;
  readonly toolName?: string;
  readonly content?: string;
  readonly approved?: boolean;
  readonly task?: string;
  readonly toolCallId?: string;
  readonly message?: string;
  readonly previewDiff?: string;
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        onLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

function createProgressReporter(
  config: BridgeConfig,
  channelId: string,
  messageId: string,
  runToken: string,
) {
  const tools: string[] = [];
  const subagents: string[] = [];
  const declined: string[] = [];
  let reasoning = "";
  let writing = false;
  let lastText = "";
  let lastEditAt = 0;
  let editing = false;

  const render = (): string => {
    const lines = ["🤔 **Working…**"];
    const thought = reasoningSnippet(reasoning);
    if (thought) lines.push(`💭 ${thought}`);
    for (const tool of tools.slice(-PROGRESS_MAX_TOOLS_SHOWN)) {
      lines.push(`🔧 \`${tool}\``);
    }
    for (const task of subagents.slice(-PROGRESS_MAX_TOOLS_SHOWN)) {
      lines.push(`🤖 ${task}`);
    }
    for (const tool of declined) {
      lines.push(`⛔ \`${tool}\` declined (needs approval)`);
    }
    if (writing) lines.push("✍️ writing the answer…");
    return neutralizeBroadcastMentions(lines.join("\n"));
  };

  const edit = async (text: string, components: unknown[]): Promise<void> => {
    if (text === lastText || editing) return;
    editing = true;
    lastText = text;
    lastEditAt = Date.now();
    try {
      await editMessage(config.botToken, channelId, messageId, text, { components });
    } finally {
      editing = false;
    }
  };

  return {
    onEvent(event: JazzEvent): void {
      switch (event.type) {
        case "thinking_chunk":
          if (typeof event.content === "string") reasoning += event.content;
          break;
        case "tool_execution_start":
          if (typeof event.toolName === "string") tools.push(event.toolName);
          break;
        case "subagent_start":
          subagents.push(event.task?.trim() || "sub-agent");
          break;
        case "approval_resolved":
          if (event.approved === false && typeof event.toolName === "string") {
            declined.push(event.toolName);
          }
          break;
        case "text_start":
        case "text_chunk":
          writing = true;
          break;
      }
      if (Date.now() - lastEditAt >= PROGRESS_MIN_INTERVAL_MS) {
        void edit(render(), cancelComponents(runToken));
      }
    },
    finish: (summary: string): Promise<void> => edit(summary, []),
    toolsUsed: (): string[] => [...new Set(tools)],
    // The progress bubble only ever showed a rolling tail; this is everything
    // the model thought, for the spoiler log attached to the answer.
    reasoningLog: (): string => reasoning,
  };
}

const APPROVAL_MESSAGE_MAX_CHARS = 500;
const APPROVAL_PREVIEW_DIFF_MAX_CHARS = 500;

/**
 * Attach a run's full reasoning under the answer as click-to-reveal spoilers.
 * Sent as its own messages rather than appended to the answer so the answer
 * keeps its follow-up buttons and its own splitting untouched.
 */
async function sendReasoningLog(
  config: BridgeConfig,
  channelId: string,
  reasoning: string,
): Promise<void> {
  const parts = splitReasoning(reasoning, {
    budget: REASONING_PART_CHARS,
    maxParts: REASONING_MAX_PARTS,
  });
  for (const [index, part] of parts.entries()) {
    const counter = parts.length > 1 ? ` (${index + 1}/${parts.length})` : "";
    await sendReply(config, channelId, `💭 **Reasoning**${counter}\n${spoilerBlock(part)}`);
  }
}

async function sendApprovalRequest(
  config: BridgeConfig,
  channelId: string,
  runToken: string,
  event: JazzEvent,
): Promise<void> {
  const toolCallId = event.toolCallId;
  if (!toolCallId) return;

  const token = newRunToken();
  const toolName = event.toolName ?? "tool";
  const message = (event.message ?? "").slice(0, APPROVAL_MESSAGE_MAX_CHARS);
  const lines = ["⚠️ **Approval needed**", `\`${toolName}\``];
  if (message.length > 0) lines.push(message);
  if (event.previewDiff) {
    const diff = event.previewDiff.slice(0, APPROVAL_PREVIEW_DIFF_MAX_CHARS);
    lines.push("```diff", diff, "```");
  }

  const sent = await sendMessage(config.botToken, channelId, lines.join("\n"), {
    components: approvalComponents(token),
  });
  if (sent !== undefined) {
    pendingApprovals.set(token, {
      toolCallId,
      channelId,
      messageId: sent.id,
      runToken,
    });
  }
}

async function runJazz(
  config: BridgeConfig,
  channelId: string,
  prompt: string,
  onEvent: (event: JazzEvent) => void,
  runToken: string,
): Promise<JazzEnvelope> {
  const incognito = isIncognito(config.jazzHome, channelId);
  const priorIncognitoMessages = incognito ? incognitoHistory.get(channelId) : undefined;
  const child = Bun.spawn(
    [
      config.jazzBinary,
      "run",
      "--no-tui",
      "--json",
      "--events",
      "tools,reasoning,text,approval,subagent",
      "--agent",
      agentIdForChannel(channelId),
      "--approval-policy",
      config.approvalPolicy,
      ...(config.autoApproveTools.length > 0
        ? ["--auto-approve-tools", config.autoApproveTools.join(",")]
        : []),
      "--timezone",
      tzForChat(config.jazzHome, channelId),
      ...(incognito
        ? [
            "--ephemeral",
            ...(priorIncognitoMessages && priorIncognitoMessages.length > 0
              ? ["--history-json", JSON.stringify(priorIncognitoMessages)]
              : []),
          ]
        : ["--conversation", conversationKey(config.jazzHome, channelId)]),
      "--timeout",
      String(config.runTimeoutMs),
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "pipe", env: { ...process.env } },
  );
  activeRuns.set(runToken, { child, cancelled: false });

  const timeout = setTimeout(() => child.kill(), config.runTimeoutMs + 15_000);
  const stderrTail: string[] = [];
  const stderrDone = streamLines(child.stderr, (line) => {
    if (stderrTail.length < 50) stderrTail.push(line);
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      const event = JSON.parse(trimmed) as JazzEvent;
      if (typeof event.type === "string") onEvent(event);
      if (event.type === "approval_required" && event.toolCallId) {
        void sendApprovalRequest(config, channelId, runToken, event).catch((error) =>
          console.error(`Failed to send approval request for ${channelId}: ${String(error)}`),
        );
      }
    } catch {
      // Non-event stderr line — ignore.
    }
  });

  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    stderrDone,
    child.exited,
  ]);
  clearTimeout(timeout);

  const lastJsonLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);

  if (lastJsonLine === undefined) {
    console.error(
      `Jazz produced no JSON envelope (exit ${exitCode}). stderr:\n${stderrTail.join("\n")}`,
    );
    return { ok: false, error: "Jazz did not return a response." };
  }

  try {
    const envelope = JSON.parse(lastJsonLine) as JazzEnvelope;
    if (incognito && envelope.ok) {
      incognitoHistory.set(channelId, envelope.messages ?? []);
    }
    return envelope;
  } catch (error) {
    console.error(`Failed to parse Jazz envelope: ${String(error)}\nLine: ${lastJsonLine}`);
    return { ok: false, error: "Could not parse the agent response." };
  }
}

async function deliverWebApp(
  config: BridgeConfig,
  channelId: string,
  webApp: JazzWebApp,
): Promise<void> {
  if (webApp.mode === "static") {
    if (webApp.imagePath === undefined) {
      console.error(`create_web_app returned static mode with no imagePath (id=${webApp.id})`);
      return;
    }
    await sendAttachment(config.botToken, channelId, webApp.imagePath, "chart.png", webApp.title);
    return;
  }

  if (config.publicBaseUrl === undefined) {
    await sendReply(
      config,
      channelId,
      "⚠️ Generated an interactive UI, but no public URL is configured " +
        "(set `DISCORD_PUBLIC_BASE_URL`) — can't open it.",
    );
    return;
  }

  const url = `${config.publicBaseUrl}/webapps/${webApp.id}`;
  await sendReply(config, channelId, `Open **${webApp.title}**: ${url}`);
}

async function handleMessage(
  config: BridgeConfig,
  channelId: string,
  text: string,
  progressMessageId?: string,
): Promise<void> {
  ensureChatAgent(config.jazzHome, channelId, config.baseAgentId);

  const usage = todayUsage(config.jazzHome);
  const capBlockReason = dailyCostCapBlockReason(usage, config.dailyCostCapUsd);
  if (capBlockReason === "unpriced") {
    await sendReply(
      config,
      channelId,
      "⚠️ Daily cost cap paused: pricing was unavailable for an earlier run today, so spend cannot be verified. Try again tomorrow, disable the cap, or select a priced model.",
    );
    return;
  }

  if (capBlockReason === "reached") {
    await sendReply(
      config,
      channelId,
      `⚠️ Daily cost cap ($${config.dailyCostCapUsd.toFixed(2)}) reached. Try again tomorrow, or raise JAZZ_DAILY_COST_CAP_USD.`,
    );
    return;
  }

  await triggerTyping(config.botToken, channelId);

  const runToken = newRunToken();
  let messageId = progressMessageId;
  if (messageId === undefined) {
    const sent = await sendMessage(config.botToken, channelId, "🤔 **Working…**", {
      components: cancelComponents(runToken),
    });
    messageId = sent?.id;
  } else {
    await editMessage(config.botToken, channelId, messageId, "🤔 **Working…**", {
      components: cancelComponents(runToken),
    });
  }

  const reporter =
    messageId !== undefined
      ? createProgressReporter(config, channelId, messageId, runToken)
      : undefined;

  try {
    const envelope = await runJazz(
      config,
      channelId,
      text,
      (event) => reporter?.onEvent(event),
      runToken,
    );
    const cancelled = activeRuns.get(runToken)?.cancelled ?? false;

    if (cancelled) {
      await reporter?.finish("⏹ **Cancelled**");
      return;
    }

    if (envelope.ok) {
      if (envelope.costKnown === undefined) {
        console.error(
          "Envelope has no costKnown field (jazz binary predates it); treating cost as known — upgrade jazz so unpriced runs pause the daily cap.",
        );
      }
      const costKnown = envelope.costKnown !== false;
      recordUsage(
        config.jazzHome,
        envelope.costUSD,
        envelope.tokenUsage?.totalTokens ?? 0,
        costKnown,
      );
      const used = reporter?.toolsUsed() ?? [];
      const parts = ["✅ **Done**"];
      if (used.length > 0) parts.push(used.map((tool) => `\`${tool}\``).join(" "));
      if (envelope.costUSD > 0) {
        parts.push(envelope.costUSD >= 0.0001 ? `$${envelope.costUSD.toFixed(4)}` : "<$0.0001");
      } else if (!costKnown) {
        parts.push("price unavailable");
      }
      const usageLines = formatUsageLines(envelope.tokenUsage);
      await reporter?.finish(
        usageLines === undefined ? parts.join(" · ") : `${parts.join(" · ")}\n${usageLines}`,
      );
      const answerMessageId = await sendReply(config, channelId, envelope.answer, {
        components: followupComponents(),
      });
      if (config.dynamicCta && answerMessageId !== undefined) {
        void upgradeToDynamicCtas(config, channelId, answerMessageId, text, envelope.answer);
      }
      if (config.showReasoning) {
        await sendReasoningLog(config, channelId, reporter?.reasoningLog() ?? "");
      }
      if (envelope.webApp) {
        await deliverWebApp(config, channelId, envelope.webApp);
      }
    } else {
      await reporter?.finish("⚠️ **Failed**");
      await sendReply(config, channelId, `⚠️ ${envelope.error}`);
    }
  } finally {
    activeRuns.delete(runToken);
    for (const [token, pending] of pendingApprovals) {
      if (pending.runToken === runToken) pendingApprovals.delete(token);
    }
  }
}

const FOLLOWUP_OPTIONS: Record<string, { label: string; prompt: string }> = {
  deeper: {
    label: "🔍 Go deeper",
    prompt:
      "Go deeper on your previous answer: add more detail, concrete specifics, and any important nuances or caveats.",
  },
  shorter: {
    label: "✂️ Shorter",
    prompt:
      "Give a much shorter version of your previous answer — 2-3 sentences, just the essentials.",
  },
  simpler: {
    label: "🧑‍🏫 Explain simpler",
    prompt:
      "Explain your previous answer in simpler terms, as if to someone with no background in the topic — avoid jargon and use plain language.",
  },
  example: {
    label: "💡 Example",
    prompt: "Give a concrete, real-world example that illustrates your previous answer.",
  },
};

interface Suggestion {
  label: string;
  prompt: string;
}

const SUGGESTION_STORE_MAX = 500;
const suggestionStore = new Map<string, Suggestion[]>();

function storeSuggestions(items: Suggestion[]): string {
  const token = newRunToken();
  suggestionStore.set(token, items);
  while (suggestionStore.size > SUGGESTION_STORE_MAX) {
    const oldest = suggestionStore.keys().next().value;
    if (oldest === undefined) break;
    suggestionStore.delete(oldest);
  }
  return token;
}

function suggestionComponents(token: string, items: Suggestion[]): unknown[] {
  return items.map((item, index) =>
    actionRow([button(`s:${token}:${index}`, item.label, BUTTON_SECONDARY)]),
  );
}

async function jazzJson(
  config: BridgeConfig,
  agentId: string,
  prompt: string,
  extraArgs: string[],
): Promise<JazzEnvelope> {
  const child = Bun.spawn(
    [config.jazzBinary, "run", "--no-tui", "--json", "--agent", agentId, ...extraArgs, prompt],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const timeout = setTimeout(() => child.kill(), 90_000);
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  if (line === undefined) return { ok: false, error: "no output" };
  try {
    return JSON.parse(line) as JazzEnvelope;
  } catch {
    return { ok: false, error: "unparseable output" };
  }
}

const SUGGEST_AGENT_ID = "dc_suggest";

function ensureSuggestAgent(config: BridgeConfig): void {
  if (existsSync(agentPath(config.jazzHome, SUGGEST_AGENT_ID))) return;
  const template = readAgentFile(config.jazzHome, config.baseAgentId);
  template.id = SUGGEST_AGENT_ID;
  template.name = SUGGEST_AGENT_ID;
  template.config["tools"] = [];
  template.config.reasoningEffort = "disable";
  writeAgentFile(config.jazzHome, template);
}

async function generateSuggestions(
  config: BridgeConfig,
  question: string,
  answer: string,
): Promise<Suggestion[]> {
  ensureSuggestAgent(config);
  const metaPrompt =
    `Conversation:\nUser: ${question.slice(0, 500)}\nAssistant: ${answer.slice(0, 1200)}\n\n` +
    "Propose 2-4 useful next actions the user might tap. Reply with ONLY a JSON array — no prose, " +
    "no code fences:\n" +
    '[{"label":"short button text, <=24 chars, may start with an emoji","prompt":"the message to ' +
    'send if tapped, written first-person as the user"}]\n' +
    'Make them specific to THIS exchange. Include one "🔍 Go deeper" style option.';
  const envelope = await jazzJson(config, SUGGEST_AGENT_ID, metaPrompt, [
    "--reasoning",
    "disable",
    "--max-iterations",
    "1",
    "--approval-policy",
    "read-only",
    "--timeout",
    "60000",
  ]);
  if (!envelope.ok) return [];

  const match = /\[[\s\S]*\]/.exec(envelope.answer);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: Suggestion[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const record = entry as { label?: unknown; prompt?: unknown };
        if (
          typeof record.label === "string" &&
          typeof record.prompt === "string" &&
          record.label.trim().length > 0 &&
          record.prompt.trim().length > 0
        ) {
          items.push({
            label: record.label.trim().slice(0, 40),
            prompt: record.prompt.trim().slice(0, 500),
          });
        }
      }
      if (items.length >= 4) break;
    }
    return items;
  } catch {
    return [];
  }
}

async function upgradeToDynamicCtas(
  config: BridgeConfig,
  channelId: string,
  messageId: string,
  question: string,
  answer: string,
): Promise<void> {
  try {
    const items = await generateSuggestions(config, question, answer);
    console.log(`[cta] channel ${channelId}: ${items.length} contextual suggestion(s)`);
    if (items.length === 0) return;
    const token = storeSuggestions(items);
    await patchMessage(config.botToken, channelId, messageId, {
      components: suggestionComponents(token, items),
    });
  } catch (error) {
    console.error(`Dynamic CTA generation failed: ${String(error)}`);
  }
}

const HELP_TEXT = [
  "I'm your Jazz assistant. Mention me in a server (or just talk here in DMs) and I'll answer.",
  "",
  "Commands:",
  "`/model` — pick which Ollama model I use (just for this conversation)",
  "`/persona` — pick my persona / style",
  "`/new` — start a fresh conversation (clears earlier context)",
  "`/incognito` — start a private conversation (nothing saved) until `/new`",
  "`/remind <when> <text>` — e.g. `/remind when:30m text:take pizza out`",
  "  …or just say it: “remind me to call the dentist in 2 hours”",
  "`/reminders` — list and cancel your reminders",
  "`/tz` — set your timezone so reminder times are local (e.g. `/tz zone:Europe/Paris`)",
  "`/status` — model, today's usage, uptime",
  "`/help` — show this",
  "",
  "In a server I only reply when mentioned, when you reply to me, or in a thread I already joined.",
].join("\n");

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Model, today's usage, uptime" },
  { name: "new", description: "Start a fresh conversation (clears earlier context)" },
  { name: "incognito", description: "Start a private conversation (nothing saved) until /new" },
  { name: "model", description: "Pick which Ollama model I use (just for this conversation)" },
  { name: "persona", description: "Pick my persona / style" },
  { name: "reminders", description: "List and cancel your reminders" },
  {
    name: "tz",
    description: "Show or set your timezone",
    options: [
      {
        name: "zone",
        description: "IANA timezone, e.g. Europe/Paris",
        type: 3,
      },
    ],
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

function remindersFilePath(dataDir: string, channelId: string): string {
  return join(dataDir, "reminders", `${agentIdForChannel(channelId)}.json`);
}

function readRemindersForDisplay(dataDir: string, channelId: string): ReminderRecord[] {
  try {
    const path = remindersFilePath(dataDir, channelId);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ReminderRecord[]) : [];
  } catch {
    return [];
  }
}

async function cancelReminderForChannel(
  dataDir: string,
  channelId: string,
  id: string,
): Promise<boolean> {
  const service = new ReminderServiceImpl({ baseReminderDirectory: join(dataDir, "reminders") });
  const outcome = await Effect.runPromise(
    service.cancel(agentIdForChannel(channelId), id).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  return outcome.success;
}

async function listOllamaModels(config: BridgeConfig): Promise<string[]> {
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/tags`);
    const data = (await response.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");
    return names.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    console.error(`Failed to list Ollama models: ${String(error)}`);
    return [];
  }
}

async function modelSupportsThinking(config: BridgeConfig, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, name: model }),
    });
    const data = (await response.json()) as { capabilities?: string[] };
    return Array.isArray(data.capabilities) && data.capabilities.includes("thinking");
  } catch (error) {
    console.error(`Failed to probe model capabilities for ${model}: ${String(error)}`);
    return false;
  }
}

function listPersonasIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "persona.md")),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listPersonas(config: BridgeConfig): string[] {
  const found = new Set<string>([
    ...listPersonasIn(config.builtinPersonasDir),
    ...listPersonasIn(join(config.jazzHome, "personas")),
  ]);
  found.delete("summarizer");
  const names = [...found];
  if (names.length === 0) return ["default", "coder", "researcher"];
  return names.sort((left, right) => left.localeCompare(right));
}

interface CommandResult {
  readonly content: string;
  readonly components?: unknown[];
  readonly runPrompt?: string;
}

async function handleCommand(
  config: BridgeConfig,
  channelId: string,
  command: string,
  args: string,
): Promise<CommandResult> {
  const agent = ensureChatAgent(config.jazzHome, channelId, config.baseAgentId);

  if (command === "remind") {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
      return {
        content:
          "Usage: `/remind when:<when> text:<text>`\n" +
          "Examples: `30m take pizza out`, `18:00 standup`, `tomorrow 09:00 gym`, `2026-08-25 20:00 pack shoes`",
      };
    }
    return { content: "Setting that reminder…", runPrompt: `Add a reminder: ${trimmed}` };
  }

  if (command === "tz" || command === "timezone") {
    const requested = args.trim();
    if (requested.length === 0) {
      const current = tzForChat(config.jazzHome, channelId);
      const suffix = hasChatTz(config.jazzHome, channelId) ? "" : " (default — not set by you yet)";
      return {
        content:
          `🌍 Your timezone: \`${current}\`${suffix}\n` +
          `Local time now: ${formatWhen(Date.now(), current)}\n\n` +
          "Change it with `/tz zone:Europe/Paris` (an IANA name like `America/New_York`, `Asia/Tokyo`).",
      };
    }
    if (!isValidTimeZone(requested)) {
      return {
        content:
          `I don't recognise “${requested}”. Use an IANA name such as ` +
          "`Europe/Paris`, `America/New_York`, or `Asia/Tokyo`.",
      };
    }
    setTzForChat(config.jazzHome, channelId, requested);
    return {
      content:
        `✅ Timezone set to \`${requested}\`. Local time now: ${formatWhen(Date.now(), requested)}.\n` +
        "Reminders will use this from now on.",
    };
  }

  if (command === "reminders") {
    const mine = readRemindersForDisplay(config.jazzHome, channelId).sort(
      (left, right) => left.fireAt - right.fireAt,
    );
    if (mine.length === 0) {
      return { content: "No reminders set. Use `/remind when:<when> text:<text>`." };
    }
    const tz = tzForChat(config.jazzHome, channelId);
    const rows = mine
      .slice(0, 25)
      .map((reminder) =>
        actionRow([
          button(
            `r:${reminder.id}`,
            `❌ ${formatWhen(reminder.fireAt, tz)} — ${reminder.text.slice(0, 24)}`,
            BUTTON_DANGER,
          ),
        ]),
      );
    return { content: `Pending reminders (tap to cancel · times in ${tz}):`, components: rows };
  }

  if (command === "new" || command === "reset") {
    const wasIncognito = isIncognito(config.jazzHome, channelId);
    if (wasIncognito) {
      setIncognito(config.jazzHome, channelId, false);
      incognitoHistory.delete(channelId);
    }
    startNewConversation(config.jazzHome, channelId);
    return {
      content: wasIncognito
        ? "🆕 Incognito conversation ended and discarded. Back to normal — your model and persona stay the same."
        : "🆕 Fresh conversation — I've cleared the earlier context. Your model and persona stay the same.",
    };
  }

  if (command === "incognito") {
    setIncognito(config.jazzHome, channelId, true);
    incognitoHistory.delete(channelId);
    return {
      content:
        "🕶️ Incognito mode on — nothing from this conversation is saved to history or memory. Send `/new` to end it.",
    };
  }

  if (command === "status") {
    const day = todayUsage(config.jazzHome);
    const cap = config.dailyCostCapUsd;
    const lines = [
      "📊 **Status**",
      ...(isIncognito(config.jazzHome, channelId)
        ? ["🕶️ Incognito — nothing being saved right now"]
        : []),
      `Model: \`${agent.config.llmProvider}/${agent.config.llmModel}\` (reasoning: ${agent.config.reasoningEffort})`,
      `Timezone: \`${tzForChat(config.jazzHome, channelId)}\`${hasChatTz(config.jazzHome, channelId) ? "" : " (default)"}`,
      `Today: ${day.runs} runs · ${formatTokenCount(day.tokens)} tok · $${day.costUSD.toFixed(4)}${(day.unpricedRuns ?? 0) > 0 ? ` · ${day.unpricedRuns} unpriced` : ""}`,
      `Daily cap: ${cap > 0 ? `$${cap.toFixed(2)}` : "none"}`,
      `Uptime: ${formatUptime(Date.now() - BRIDGE_STARTED_AT)}`,
    ];
    return { content: lines.join("\n") };
  }

  if (command === "model") {
    const models = await listOllamaModels(config);
    if (models.length === 0) {
      return { content: "⚠️ No models available from Ollama right now." };
    }
    const options = models.slice(0, 25).map((model) => ({
      label: model,
      value: model,
      default: model === agent.config.llmModel,
    }));
    return {
      content: "Pick a model:",
      components: [actionRow([stringSelect("m", "Model", options)])],
    };
  }

  if (command === "persona") {
    const personas = listPersonas(config);
    const options = personas.slice(0, 25).map((persona) => ({
      label: persona,
      value: persona,
      default: persona === agent.config.persona,
    }));
    return {
      content: "Pick a persona:",
      components: [actionRow([stringSelect("p", "Persona", options)])],
    };
  }

  return { content: HELP_TEXT };
}

async function applyModelChoice(
  config: BridgeConfig,
  channelId: string,
  model: string,
): Promise<string> {
  const agent = ensureChatAgent(config.jazzHome, channelId, config.baseAgentId);
  const reasoning = (await modelSupportsThinking(config, model)) ? "medium" : "disable";
  agent.model = `ollama/${model}`;
  agent.config.llmModel = model;
  agent.config.llmProvider = "ollama";
  agent.config.reasoningEffort = reasoning;
  writeAgentFile(config.jazzHome, agent);
  return `✅ Model → ${model}\nReasoning: ${reasoning}`;
}

function applyPersonaChoice(config: BridgeConfig, channelId: string, persona: string): string {
  const agent = ensureChatAgent(config.jazzHome, channelId, config.baseAgentId);
  agent.config.persona = persona;
  writeAgentFile(config.jazzHome, agent);
  return `✅ Persona → ${persona}`;
}

function slashOption(interaction: DiscordInteraction, name: string): string | undefined {
  const options = interaction.data?.options ?? [];
  const match = options.find((option) => option.name === name);
  return typeof match?.value === "string" ? match.value : undefined;
}

function accessContextForMessage(
  message: DiscordMessage,
  meta: ChannelMeta,
  botUserId: string,
  dataDir: string,
): Parameters<typeof isSenderAllowed>[1] {
  const isDm = meta.type === CHANNEL_TYPE_DM;
  const isThread = isThreadChannelType(meta.type);
  return {
    isDm,
    isThread,
    userId: message.author.id,
    channelId: message.channel_id,
    parentChannelId: meta.parentId,
    guildId: message.guild_id ?? meta.guildId,
    mentionedBot:
      messageMentionsUser(message.content, botUserId) ||
      (message.mentions ?? []).some((user) => user.id === botUserId),
    replyToBot: message.referenced_message?.author?.id === botUserId,
    threadHasSession: isThread && hasChatAgent(dataDir, message.channel_id),
  };
}

async function bindThreadIfNeeded(
  config: BridgeConfig,
  message: DiscordMessage,
  meta: ChannelMeta,
  prompt: string,
): Promise<{ channelId: string; meta: ChannelMeta }> {
  const isDm = meta.type === CHANNEL_TYPE_DM;
  const isThread = isThreadChannelType(meta.type);
  if (isDm || isThread || !config.createThreads) {
    return { channelId: message.channel_id, meta };
  }
  const thread = await createThreadFromMessage(
    config.botToken,
    message.channel_id,
    message.id,
    threadNameFromPrompt(prompt),
  );
  if (thread === undefined) {
    return { channelId: message.channel_id, meta };
  }
  const threadMeta: ChannelMeta = {
    type: thread.type,
    parentId: message.channel_id,
    guildId: message.guild_id ?? meta.guildId,
  };
  rememberChannel(thread.id, threadMeta);
  return { channelId: thread.id, meta: threadMeta };
}

async function dispatchMessage(
  config: BridgeConfig,
  runtime: Runtime,
  message: DiscordMessage,
): Promise<void> {
  if (message.author.id === runtime.botUserId) return;
  if (message.author.bot === true) return;
  if (!isRespondableMessage(message)) return;

  const meta = await resolveChannel(config, message.channel_id);
  if (meta.type === CHANNEL_TYPE_GROUP_DM) return;

  const context = accessContextForMessage(message, meta, runtime.botUserId, config.jazzHome);
  if (!isSenderAllowed(config, context)) {
    console.warn(
      `Ignoring message from non-allowed user ${message.author.id} in ${message.channel_id}`,
    );
    return;
  }
  if (!shouldRespond(config, context)) return;

  if (message.content.trim().length === 0) {
    if (context.mentionedBot) {
      await sendReply(
        config,
        message.channel_id,
        "I can see you mentioned me but not the text — enable the **Message Content Intent** for this bot in the Discord developer portal.",
      );
    }
    return;
  }

  const stripped = stripBotMention(message.content, runtime.botUserId);
  if (stripped.length === 0) return;

  const parsed = parseCommand(stripped);
  const known = new Set([
    "help",
    "status",
    "new",
    "reset",
    "incognito",
    "model",
    "persona",
    "remind",
    "reminders",
    "tz",
    "timezone",
  ]);

  try {
    if (parsed !== undefined && known.has(parsed.command)) {
      const bound = await bindThreadIfNeeded(config, message, meta, stripped);
      const result = await handleCommand(config, bound.channelId, parsed.command, parsed.args);
      await sendReply(config, bound.channelId, result.content, {
        ...(result.components !== undefined ? { components: result.components } : {}),
      });
      if (result.runPrompt !== undefined) {
        await handleMessage(config, bound.channelId, result.runPrompt);
      }
      return;
    }

    const bound = await bindThreadIfNeeded(config, message, meta, stripped);
    await handleMessage(config, bound.channelId, stripped);
  } catch (error) {
    console.error(`Handling failed for ${message.channel_id}: ${String(error)}`);
    await sendReply(
      config,
      message.channel_id,
      "⚠️ Something went wrong handling your message.",
    ).catch((replyError) =>
      console.error(`Failed to notify ${message.channel_id}: ${String(replyError)}`),
    );
  }
}

function senderAllowedForInteraction(
  config: BridgeConfig,
  interaction: DiscordInteraction,
  meta: ChannelMeta,
): boolean {
  const userId = interactionUserId(interaction);
  if (userId === undefined) return false;
  const isDm = meta.type === CHANNEL_TYPE_DM || interaction.guild_id === undefined;
  const isThread = isThreadChannelType(meta.type);
  return isSenderAllowed(config, {
    isDm,
    isThread,
    userId,
    channelId: interaction.channel_id ?? "",
    parentChannelId: meta.parentId,
    guildId: interaction.guild_id ?? meta.guildId,
    mentionedBot: true,
    replyToBot: false,
    threadHasSession: isThread && hasChatAgent(config.jazzHome, interaction.channel_id ?? ""),
  });
}

async function dispatchSlash(
  config: BridgeConfig,
  runtime: Runtime,
  interaction: DiscordInteraction,
): Promise<void> {
  const channelId = interaction.channel_id;
  if (channelId === undefined) {
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_CHANNEL_MESSAGE,
      data: { content: "I need a channel to reply in.", flags: FLAG_EPHEMERAL },
    });
    return;
  }
  const meta = await resolveChannel(config, channelId);
  if (!senderAllowedForInteraction(config, interaction, meta)) {
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_CHANNEL_MESSAGE,
      data: { content: "You're not on the allowlist for this bot.", flags: FLAG_EPHEMERAL },
    });
    return;
  }

  const name = interaction.data?.name ?? "help";
  let args = "";
  if (name === "remind") {
    const when = slashOption(interaction, "when") ?? "";
    const text = slashOption(interaction, "text") ?? "";
    args = `${when} ${text}`.trim();
  } else if (name === "tz") {
    args = slashOption(interaction, "zone") ?? "";
  }

  const needsDefer = name === "model" || name === "remind";
  if (needsDefer) {
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_DEFERRED_CHANNEL_MESSAGE,
    });
  }

  const result = await handleCommand(config, channelId, name, args);

  if (needsDefer) {
    if (result.runPrompt !== undefined) {
      const original = await getOriginalInteraction(runtime.applicationId, interaction.token);
      await handleMessage(config, channelId, result.runPrompt, original?.id);
      return;
    }
    await editOriginalInteraction(runtime.applicationId, interaction.token, {
      content: neutralizeBroadcastMentions(result.content),
      ...(result.components !== undefined ? { components: result.components } : {}),
    });
    return;
  }

  await interactionCallback(interaction.id, interaction.token, {
    type: CALLBACK_CHANNEL_MESSAGE,
    data: {
      content: neutralizeBroadcastMentions(result.content),
      allowed_mentions: { parse: [] },
      ...(result.components !== undefined ? { components: result.components } : {}),
    },
  });
}

async function dispatchComponent(
  config: BridgeConfig,
  interaction: DiscordInteraction,
): Promise<void> {
  const channelId = interaction.channel_id ?? interaction.message?.channel_id;
  const messageId = interaction.message?.id;
  const customId = interaction.data?.custom_id ?? "";
  if (channelId === undefined || messageId === undefined) {
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_CHANNEL_MESSAGE,
      data: { content: "Missing message context.", flags: FLAG_EPHEMERAL },
    });
    return;
  }

  const meta = await resolveChannel(config, channelId);
  if (!senderAllowedForInteraction(config, interaction, meta)) {
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_CHANNEL_MESSAGE,
      data: { content: "You're not on the allowlist for this bot.", flags: FLAG_EPHEMERAL },
    });
    return;
  }

  const parts = customId.split(":");
  const kind = parts[0];

  if (kind === "s") {
    const items = suggestionStore.get(parts[1] ?? "");
    const index = Number.parseInt(parts[2] ?? "", 10);
    const item = items !== undefined && Number.isInteger(index) ? items[index] : undefined;
    if (!item) {
      await interactionCallback(interaction.id, interaction.token, {
        type: CALLBACK_CHANNEL_MESSAGE,
        data: {
          content: "That suggestion expired — just ask me directly.",
          flags: FLAG_EPHEMERAL,
        },
      });
      return;
    }
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: { components: [] },
    });
    // A bot cannot post as the clicker, so the echo is attributed subtext
    // rather than a plain line that reads as the bot talking to itself.
    const requesterId = interactionUserId(interaction);
    const echo = requesterId === undefined ? item.label : `<@${requesterId}> · ${item.label}`;
    await sendReply(config, channelId, `-# ${echo}`);
    void handleMessage(config, channelId, item.prompt).catch((error) =>
      console.error(`Suggestion follow-up failed for ${channelId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "x") {
    const runToken = parts[1] ?? "";
    const run = activeRuns.get(runToken);
    if (run) {
      run.cancelled = true;
      run.child.kill();
    }
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: { content: run ? "⏹ Cancelling…" : "Already finished.", components: [] },
    });
    for (const [token, pending] of pendingApprovals) {
      if (pending.runToken !== runToken) continue;
      pendingApprovals.delete(token);
      await patchMessage(config.botToken, pending.channelId, pending.messageId, {
        components: [],
      }).catch(() => undefined);
    }
    return;
  }

  if (kind === "a") {
    const token = parts[1] ?? "";
    const approved = parts[2] === "1";
    const pending = pendingApprovals.get(token);
    const run = pending ? activeRuns.get(pending.runToken) : undefined;
    if (!pending || !run) {
      await interactionCallback(interaction.id, interaction.token, {
        type: CALLBACK_CHANNEL_MESSAGE,
        data: {
          content: "This approval already expired or the run finished.",
          flags: FLAG_EPHEMERAL,
        },
      });
      return;
    }
    pendingApprovals.delete(token);
    try {
      run.child.stdin.write(
        `${JSON.stringify({ type: "approval_decision", toolCallId: pending.toolCallId, approved })}\n`,
      );
      run.child.stdin.flush();
    } catch (error) {
      console.error(`Failed to write approval decision: ${String(error)}`);
    }
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: {
        content: approved ? "✅ Approved" : "❌ Rejected",
        components: [],
      },
    });
    return;
  }

  if (kind === "f") {
    const option = FOLLOWUP_OPTIONS[parts[1] ?? ""];
    if (!option) {
      await interactionCallback(interaction.id, interaction.token, {
        type: CALLBACK_DEFERRED_UPDATE,
      });
      return;
    }
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: { components: [] },
    });
    await sendReply(config, channelId, option.label);
    void handleMessage(config, channelId, option.prompt).catch((error) =>
      console.error(`Follow-up failed for ${channelId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "r") {
    const cancelled = await cancelReminderForChannel(config.jazzHome, channelId, parts[1] ?? "");
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: {
        content: cancelled ? "Reminder cancelled." : "Reminder not found.",
        components: [],
      },
    });
    return;
  }

  if (kind === "m" || kind === "p") {
    const value = interaction.data?.values?.[0];
    if (value === undefined) {
      await interactionCallback(interaction.id, interaction.token, {
        type: CALLBACK_CHANNEL_MESSAGE,
        data: { content: "Nothing selected.", flags: FLAG_EPHEMERAL },
      });
      return;
    }
    const confirmation =
      kind === "m"
        ? await applyModelChoice(config, channelId, value)
        : applyPersonaChoice(config, channelId, value);
    await interactionCallback(interaction.id, interaction.token, {
      type: CALLBACK_UPDATE_MESSAGE,
      data: { content: confirmation, components: [] },
    });
    return;
  }

  await interactionCallback(interaction.id, interaction.token, {
    type: CALLBACK_DEFERRED_UPDATE,
  });
}

async function dispatchInteraction(
  config: BridgeConfig,
  runtime: Runtime,
  interaction: DiscordInteraction,
): Promise<void> {
  if (interaction.type === INTERACTION_PING) {
    await interactionCallback(interaction.id, interaction.token, { type: 1 });
    return;
  }
  if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
    await dispatchSlash(config, runtime, interaction);
    return;
  }
  if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
    await dispatchComponent(config, interaction);
  }
}

function startHealthServer(config: BridgeConfig): void {
  Bun.serve({
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      const webAppMatch =
        request.method === "GET" ? /^\/webapps\/([A-Za-z0-9_-]+)$/.exec(url.pathname) : null;
      if (webAppMatch) {
        const id = webAppMatch[1];
        const file = Bun.file(`${webAppsDirectory(config)}/${id}.html`);
        if (!(await file.exists())) {
          return new Response("not found", { status: 404 });
        }
        return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Health server listening on :${config.port}`);
}

async function start(): Promise<void> {
  const config = loadConfig();
  rmSync(agentPath(config.jazzHome, SUGGEST_AGENT_ID), { force: true });
  startHealthServer(config);
  startReminderSweep(config.jazzHome, (channelId, markdown) =>
    sendReply(config, channelId, markdown),
  );

  let runtime: Runtime | undefined;

  connectGateway(config.botToken, {
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
      void dispatchMessage(config, runtime, message);
    },
    onInteraction(interaction) {
      if (runtime === undefined) return;
      void dispatchInteraction(config, runtime, interaction).catch((error) =>
        console.error(`Interaction handling failed: ${String(error)}`),
      );
    },
  });
}

start().catch((error) => {
  console.error(`Bridge failed to start: ${String(error)}`);
  process.exit(1);
});

/**
 * Telegram → Jazz bridge.
 *
 * For each incoming text message it runs a per-chat Jazz agent once
 * (`jazz run --json`) and replies with the answer. Per-chat memory comes from
 * Jazz's `--conversation <chat_id>` flag; per-chat model/persona come from a
 * dedicated agent file per chat (`tg_<chat_id>.json`), cloned from the seeded
 * template agent and switched live via the /model and /persona commands.
 *
 * Two transports, chosen by TELEGRAM_MODE:
 *   - "polling"  (default) — getUpdates long-poll; no public endpoint needed.
 *   - "webhook"            — Telegram POSTs to /telegram/webhook (needs a public URL).
 *
 * A minimal /health server always runs for container health checks.
 *
 * Runs on Bun. All configuration is via environment variables (see .env.example).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { createConfigLayer } from "@jazz/adapters/config";
import { ReminderServiceImpl } from "@jazz/adapters/reminder-service";
import { listPersonaNames } from "@jazz/bot-shared/personas";
import { listModelsForProvider } from "@jazz/bot-shared/provider-models";
import { reasoningSnippet, splitReasoning } from "@jazz/bot-shared/reasoning";
import { createRunLog, type RunLog } from "@jazz/bot-shared/run-log";
import {
  conversationKey,
  isIncognito,
  setIncognito,
  startNewConversation,
} from "@jazz/bot-shared/session-store";
import {
  formatWhen,
  hasChatTz,
  isValidTimeZone,
  setTzForChat,
  tzForChat,
} from "@jazz/bot-shared/timezone-store";
import { dailyCostCapBlockReason, recordUsage, todayUsage } from "@jazz/bot-shared/usage-store";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@jazz/core/constants/models";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import type { ReminderRecord } from "@jazz/core/interfaces/reminder-service";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { parseProviderModel } from "@jazz/core/utils/provider-model";
import { extractCommandApprovalKey } from "@jazz/core/utils/shell";
import { Effect } from "effect";
import tzlookup from "tz-lookup";
import {
  agentIdForChat,
  agentPath,
  ensureChatAgent,
  readAgentFile,
  syncAgentDisplayName,
  writeAgentFile,
} from "./agents";
import { buildMediaPrompt, downloadTelegramFile, type TelegramFileRef } from "./media";
import { withReplyContext } from "./quotes";
import { startReminderSweep } from "./reminders";
import {
  escapeHtml,
  expandableBlockquote,
  markdownToTelegramHtml,
  splitForTelegram,
} from "./telegram-html";

const TZ_FILE = "tg-tz.json";
const USAGE_FILE = "tg-usage.json";
const EPOCHS_FILE = "tg-sessions.json";
const INCOGNITO_FILE = "tg-incognito.json";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const GETUPDATES_TIMEOUT_SECONDS = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;
const ALLOWED_UPDATES = ["message", "callback_query"];
// Telegram rate-limits message edits; don't refresh the progress bubble faster.
// The text the progress bubble is created with. The reporter starts from it so
// its first render is not sent as an edit to identical content, which Telegram
// rejects with a 400 on essentially every run.
const PROGRESS_INITIAL_TEXT = "🤔 <b>Working…</b>";
const PROGRESS_MIN_INTERVAL_MS = 2_000;
const PROGRESS_MAX_TOOLS_SHOWN = 8;
// The reasoning log is HTML-escaped into an expandable quote before it is
// sent. Reasoning is model prose, so escaping adds a few percent at most, but
// budget under the 3500 the answer splitter uses to keep the escaped message
// clear of Telegram's 4096 hard limit without needing to split mid-tag.
const REASONING_PART_CHARS = 2_800;
// A long agentic run would otherwise post a wall of collapsed quotes; past
// this the tail is dropped and the final part says how much.
const REASONING_MAX_PARTS = 4;

const BRIDGE_STARTED_AT = Date.now();
// In-flight runs keyed by a per-run token, so the ⏹ Cancel button can kill the
// right jazz process.
const activeRuns = new Map<
  string,
  { child: Bun.Subprocess<"pipe", "pipe", "pipe">; cancelled: boolean }
>();
// Pending human approvals keyed by toolCallId, so an Accept/Reject tap can
// find the run to write the decision back to and the message to clear.
// `commandKey` (set only for execute_command approvals) is the binary name an
// "Always allow" tap persists to autoApprovedCommands — present only when we
// could parse one out, since not every approval is a shell command.
/**
 * Questions the agent is blocked on, keyed by the id it minted. The run is
 * parked on stdin until one of these buttons is tapped, so an entry left behind
 * would be a run that never finishes — they are swept when the run ends.
 */
const pendingUserInputs = new Map<
  string,
  { chatId: number; messageId: number; runToken: string; options: readonly string[] }
>();

const pendingApprovals = new Map<
  string,
  { chatId: number; messageId: number; runToken: string; commandKey?: string }
>();
// Transcript for chats currently in /incognito mode. Lives only in this
// process's memory — never written to disk — so a bridge restart drops the
// context rather than ever falling back to a persisted history file. Cleared
// on /new (which also turns incognito off, see handleCommand).
const incognitoHistory = new Map<number, unknown[]>();

type TransportMode = "polling" | "webhook";

interface BridgeConfig {
  readonly botToken: string;
  readonly mode: TransportMode;
  readonly webhookSecret: string;
  readonly webhookUrl: string | undefined;
  readonly allowedChatIds: ReadonlySet<number>;
  readonly baseAgentId: string;
  readonly approvalPolicy: string;
  /** Tool names to auto-approve without prompting, regardless of approvalPolicy. */
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly builtinPersonasDir: string;
  readonly port: number;
  /** Per-day spend ceiling in USD across all chats; 0 disables the cap. */
  readonly dailyCostCapUsd: number;
  /** Reverse-geocoder base URL for shared locations; empty string disables it. */
  readonly geocodeUrl: string;
  /** Generate contextual follow-up CTAs per answer (a second short LLM call). */
  readonly dynamicCta: boolean;
  /**
   * Attach the run's full reasoning under the answer as collapsed,
   * tap-to-expand quotes. The live progress line only ever shows a rolling
   * tail, and that bubble is overwritten when the answer lands.
   */
  readonly showReasoning: boolean;
  /**
   * Public HTTPS origin this bridge's own HTTP server is reachable at, used to
   * build Web App button URLs for `create_web_app`'s "interactive" mode (e.g.
   * a Tailscale Funnel origin). Falls back to TELEGRAM_WEBHOOK_URL's origin in
   * webhook mode. Undefined disables interactive web apps (static/image mode
   * still works — it needs no public URL).
   */
  readonly webAppBaseUrl: string | undefined;
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
  /**
   * Only present for `--ephemeral` runs (incognito chats): the full
   * transcript, opaque to the bridge, round-tripped back in as
   * `--history-json` on that chat's next turn instead of loading it from
   * disk. See `incognitoHistory` below.
   */
  readonly messages?: unknown[];
}

interface JazzErrorEnvelope {
  readonly ok: false;
  readonly error: string;
}

type JazzEnvelope = JazzSuccessEnvelope | JazzErrorEnvelope;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function loadConfig(): BridgeConfig {
  const allowedChatIdsRaw = process.env["TELEGRAM_ALLOWED_CHAT_IDS"]?.trim() ?? "";
  const allowedChatIds = new Set(
    allowedChatIdsRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isFinite(entry)),
  );

  if (allowedChatIds.size === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_CHAT_IDS is empty. Set it to a comma-separated allow-list of chat ids so the bot only answers you.",
    );
  }

  const mode: TransportMode =
    process.env["TELEGRAM_MODE"]?.trim() === "webhook" ? "webhook" : "polling";
  const webhookUrl = process.env["TELEGRAM_WEBHOOK_URL"]?.trim() || undefined;
  const webAppBaseUrl =
    process.env["TELEGRAM_WEBAPP_BASE_URL"]?.trim() ||
    (mode === "webhook" && webhookUrl !== undefined ? new URL(webhookUrl).origin : undefined);

  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    mode,
    webhookSecret: process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim() || "",
    webhookUrl,
    allowedChatIds,
    baseAgentId: process.env["JAZZ_TELEGRAM_AGENT"]?.trim() || "telegram",
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
    geocodeUrl: process.env["NOMINATIM_BASE_URL"]?.trim() ?? "https://nominatim.openstreetmap.org",
    dynamicCta: !["0", "false", "off"].includes(
      process.env["JAZZ_TELEGRAM_DYNAMIC_CTA"]?.trim().toLowerCase() ?? "",
    ),
    showReasoning: !["0", "false", "off"].includes(
      process.env["JAZZ_TELEGRAM_SHOW_REASONING"]?.trim().toLowerCase() ?? "",
    ),
    webAppBaseUrl,
  };
}

function webAppsDirectory(config: BridgeConfig): string {
  return `${config.jazzHome}/webapps`;
}

async function callTelegram(
  config: BridgeConfig,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => undefined)) as { ok?: boolean } | undefined;
  if (!response.ok || body?.ok !== true) {
    console.error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/** Upload a local image file as a Telegram photo message (multipart, not JSON). */
async function sendPhotoFile(
  config: BridgeConfig,
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<unknown> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", Bun.file(filePath), "chart.png");
  if (caption) form.append("caption", caption);

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${config.botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const body = (await response.json().catch(() => undefined)) as { ok?: boolean } | undefined;
  if (!response.ok || body?.ok !== true) {
    console.error(`Telegram sendPhoto failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function isOkResponse(response: unknown): boolean {
  return (
    typeof response === "object" && response !== null && (response as { ok?: boolean }).ok === true
  );
}

// --- Misc utilities -------------------------------------------------------

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

// --- Location -------------------------------------------------------------

/** Reverse-geocode coordinates to a human address, or null on failure/disabled. */
async function reverseGeocode(
  config: BridgeConfig,
  latitude: number,
  longitude: number,
): Promise<string | null> {
  if (config.geocodeUrl.length === 0) return null;
  try {
    const base = config.geocodeUrl.replace(/\/$/, "");
    const url = `${base}/reverse?format=jsonv2&zoom=18&addressdetails=0&lat=${latitude}&lon=${longitude}`;
    const response = await fetch(url, {
      headers: { "user-agent": "jazz-telegram-bot/1.0 (+https://github.com/lvndry/jazz)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { display_name?: string };
    return typeof data.display_name === "string" ? data.display_name : null;
  } catch (error) {
    console.error(`Reverse geocode failed: ${String(error)}`);
    return null;
  }
}

/** Turn a shared location into a prompt and run it through the normal pipeline. */
/** Best-effort: set the chat's timezone from shared coordinates, and tell them. */
async function maybeSetTzFromLocation(
  config: BridgeConfig,
  chatId: number,
  latitude: number,
  longitude: number,
): Promise<void> {
  let detected: string;
  try {
    detected = tzlookup(latitude, longitude);
  } catch {
    return; // outside the lookup's coverage — leave the zone as-is
  }
  if (!isValidTimeZone(detected)) return;
  const previous = setTzForChat(config.jazzHome, TZ_FILE, chatId, detected);
  if (previous === detected) return; // already on this zone — nothing to announce
  const hadZone = typeof previous === "string" && isValidTimeZone(previous);
  await sendReply(
    config,
    chatId,
    `🌍 ${hadZone ? "Updated" : "Set"} your timezone to <code>${escapeHtml(detected)}</code> ` +
      "from this location — reminders will use it. Change it anytime with <code>/tz</code>.",
  );
}

async function handleLocation(
  config: BridgeConfig,
  chatId: number,
  latitude: number,
  longitude: number,
): Promise<void> {
  await maybeSetTzFromLocation(config, chatId, latitude, longitude);
  const address = await reverseGeocode(config, latitude, longitude);
  const mapLink = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
  const prompt =
    "[The user shared their current location.]\n" +
    `Coordinates: latitude ${latitude}, longitude ${longitude}\n` +
    (address ? `Approximate address (reverse-geocoded): ${address}\n` : "") +
    `Map: ${mapLink}\n\n` +
    "Tell me briefly where this is (neighborhood and a nearby landmark), then ask what I need — " +
    "directions to a place, the nearest something, etc. Use web search for anything nearby or for routing.";
  await handleMessage(config, chatId, prompt);
}

// --- Persona discovery ----------------------------------------------------

function listPersonas(config: BridgeConfig): Promise<string[]> {
  return listPersonaNames(config.jazzHome, config.builtinPersonasDir);
}

function messageIdOf(response: unknown): number | undefined {
  const id = (response as { result?: { message_id?: number } } | undefined)?.result?.message_id;
  return typeof id === "number" ? id : undefined;
}

/**
 * Send a reply, splitting to fit Telegram's message limit and attaching
 * `markup` to the final chunk. Text is treated as ready-to-send Telegram HTML
 * (command replies, confirmations); set `markdown: true` for content authored
 * in Markdown (the agent's answer), which is converted per chunk. Any
 * dynamic/untrusted text interpolated into HTML must be escaped by the caller.
 */
async function sendReply(
  config: BridgeConfig,
  chatId: number,
  text: string,
  options: { markup?: Record<string, unknown>; markdown?: boolean } = {},
): Promise<number | undefined> {
  const chunks = splitForTelegram(text);
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const markup =
      options.markup !== undefined && index === chunks.length - 1 ? options.markup : undefined;
    const rendered = await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: options.markdown ? markdownToTelegramHtml(chunk) : chunk,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    });
    if (isOkResponse(rendered)) {
      lastMessageId = messageIdOf(rendered) ?? lastMessageId;
    } else {
      // Rendering was rejected (malformed entities, too long, …) — send raw text.
      const plain = await callTelegram(config, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(markup ? { reply_markup: markup } : {}),
      });
      lastMessageId = messageIdOf(plain) ?? lastMessageId;
    }
  }
  return lastMessageId;
}

function cancelKeyboard(runToken: string): Record<string, unknown> {
  return { inline_keyboard: [[{ text: "⏹ Cancel", callback_data: `x:${runToken}` }]] };
}

function approvalKeyboard(toolCallId: string, commandKey?: string): Record<string, unknown> {
  const rows = [
    [
      { text: "✅ Accept", callback_data: `a:${toolCallId}:1` },
      { text: "❌ Reject", callback_data: `a:${toolCallId}:0` },
    ],
  ];
  if (commandKey) {
    rows.push([{ text: `♾️ Always allow "${commandKey}"`, callback_data: `a:${toolCallId}:2` }]);
  }
  return { inline_keyboard: rows };
}

/** Extract the binary from an execute_command approval's "Command: ..." line, if present. */
function commandKeyFromApprovalMessage(
  toolName: string | undefined,
  message: string,
): string | undefined {
  if (toolName !== "execute_command") return undefined;
  const match = /^Command: (.+)$/m.exec(message);
  if (!match?.[1]) return undefined;
  return extractCommandApprovalKey(match[1]).split(" ")[0];
}

/**
 * Persist a command key to autoApprovedCommands in config.json so future
 * `jazz run` invocations (each a fresh process — nothing in-memory here
 * would survive to the next message) auto-approve it without prompting.
 * Goes through the same `AgentConfigService` the CLI itself uses to mutate
 * config.json, rather than a hand-rolled read/modify/write, so this stays
 * consistent with whatever else (secrets, mcpOverrides) that file holds.
 */
async function addAutoApprovedCommand(jazzHome: string, commandKey: string): Promise<void> {
  const configLayer = createConfigLayer(undefined, join(jazzHome, "config.json"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const current = yield* configService.getOrElse<readonly string[]>("autoApprovedCommands", []);
      if (current.includes(commandKey)) return;
      yield* configService.set("autoApprovedCommands", [...current, commandKey]);
    }).pipe(Effect.provide(configLayer), Effect.provide(NodeFileSystem.layer)),
  );
}

function webAppKeyboard(url: string, title: string): Record<string, unknown> {
  return { inline_keyboard: [[{ text: `📱 ${title}`, web_app: { url } }]] };
}

function followupKeyboard(): Record<string, unknown> {
  const buttons = Object.entries(FOLLOWUP_OPTIONS).map(([key, option]) => ({
    text: option.label,
    callback_data: `f:${key}`,
  }));
  // Two per row so the labels stay readable on a mobile-width keyboard.
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return { inline_keyboard: rows };
}

// --- Live progress --------------------------------------------------------

// A subset of Jazz's NDJSON stream events (jazz run --events); other fields ignored.
interface JazzEvent {
  readonly type: string;
  readonly toolName?: string;
  readonly content?: string;
  readonly approved?: boolean;
  readonly task?: string;
  readonly toolCallId?: string;
  readonly message?: string;
  readonly previewDiff?: string;
  // `user_input_required`: the agent is blocked on a question for the human.
  readonly requestId?: string;
  readonly question?: string;
  readonly suggestions?: readonly { value: string; label?: string; description?: string }[];
}

/** Read a byte stream and invoke onLine for each newline-delimited line. */
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

/**
 * Live-updates one Telegram message ("🤔 Working…") from Jazz stream events:
 * current thinking, tools being called, and the writing phase. Edits are
 * throttled and serialized so we never spam or race Telegram's edit API.
 */
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
    `Input: ${formatTokenCount(promptTokens)}${cached}`,
    `Output: ${formatTokenCount(completionTokens)}`,
  ].join("\n");
}

function createProgressReporter(
  config: BridgeConfig,
  chatId: number,
  messageId: number,
  runToken: string,
  runLog: RunLog,
) {
  const tools: string[] = [];
  const subagents: string[] = [];
  const declined: string[] = [];
  let reasoning = "";
  let writing = false;
  let rounds = 0;
  let lastText = PROGRESS_INITIAL_TEXT;
  let lastEditAt = 0;
  let editing = false;

  const render = (): string => {
    const lines = ["🤔 <b>Working…</b>"];
    const thought = reasoningSnippet(reasoning);
    if (thought) lines.push(`💭 ${escapeHtml(thought)}`);
    for (const tool of tools.slice(-PROGRESS_MAX_TOOLS_SHOWN)) {
      lines.push(`🔧 <code>${escapeHtml(tool)}</code>`);
    }
    for (const task of subagents.slice(-PROGRESS_MAX_TOOLS_SHOWN)) {
      lines.push(`🤖 ${escapeHtml(task)}`);
    }
    for (const tool of declined) {
      lines.push(`⛔ <code>${escapeHtml(tool)}</code> declined (needs approval)`);
    }
    // A run that goes round and round looks identical to a slow one from the
    // outside; the count is what makes a loop visible without reading logs.
    if (rounds > 1) lines.push(`↻ round ${rounds}`);
    if (writing) lines.push("✍️ writing the answer…");
    return lines.join("\n");
  };

  const edit = async (text: string, markup: Record<string, unknown>): Promise<void> => {
    if (text === lastText || editing) return;
    editing = true;
    lastText = text;
    lastEditAt = Date.now();
    try {
      await callTelegram(config, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
    } finally {
      editing = false;
    }
  };

  return {
    onEvent(event: JazzEvent): void {
      runLog.event(event);
      switch (event.type) {
        case "tools_detected":
          // One per model response that asked for tools, so one per loop round.
          rounds += 1;
          break;
        case "thinking_chunk":
          // Accumulate raw so a lone-space chunk isn't trimmed away (which would
          // glue the surrounding words); normalization happens at render time.
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
        void edit(render(), cancelKeyboard(runToken));
      }
    },
    // Final edit drops the Cancel button (empty keyboard).
    finish: (summary: string): Promise<void> => edit(summary, { inline_keyboard: [] }),
    toolsUsed: (): string[] => [...new Set(tools)],
    rounds: (): number => rounds,
    // The progress bubble only ever showed a rolling tail; this is everything
    // the model thought, for the expandable log attached to the answer.
    reasoningLog: (): string => reasoning,
  };
}

/**
 * Attach a run's full reasoning under the answer as collapsed, tap-to-expand
 * quotes. Sent as its own messages rather than appended to the answer so the
 * answer keeps its follow-up buttons and its own splitting, and sent through
 * callTelegram rather than sendReply so the answer splitter can never cut one
 * of these in the middle of a blockquote tag.
 */
async function sendReasoningLog(
  config: BridgeConfig,
  chatId: number,
  reasoning: string,
): Promise<void> {
  const parts = splitReasoning(reasoning, {
    budget: REASONING_PART_CHARS,
    maxParts: REASONING_MAX_PARTS,
  });
  for (const [index, part] of parts.entries()) {
    const counter = parts.length > 1 ? ` (${index + 1}/${parts.length})` : "";
    const rendered = await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: `💭 <b>Reasoning</b>${counter}\n${expandableBlockquote(part)}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    if (!isOkResponse(rendered)) {
      // Older Bot API versions reject `expandable`; the thinking still matters
      // more than the affordance, so fall back to plain text.
      await callTelegram(config, "sendMessage", {
        chat_id: chatId,
        text: `💭 Reasoning${counter}\n${part}`,
      });
    }
  }
}

// --- Human approval --------------------------------------------------------

/**
 * Send a new Telegram message with Accept/Reject buttons for a tool awaiting
 * human approval. A new message (not an edit of the progress bubble) so
 * concurrent approvals within the same run don't collide.
 */
async function sendApprovalRequest(
  config: BridgeConfig,
  chatId: number,
  runToken: string,
  event: JazzEvent,
): Promise<void> {
  const toolCallId = event.toolCallId;
  if (!toolCallId) return;

  const toolName = event.toolName ?? "tool";
  const message = event.message ?? "";
  const commandKey = commandKeyFromApprovalMessage(event.toolName, message);
  const lines = ["⚠️ <b>Approval needed</b>", `<code>${escapeHtml(toolName)}</code>`];
  if (message.length > 0) lines.push(escapeHtml(message));
  if (event.previewDiff) {
    lines.push(`<pre>${escapeHtml(event.previewDiff)}</pre>`);
  }

  const messageId = await sendReply(config, chatId, lines.join("\n"), {
    markup: approvalKeyboard(toolCallId, commandKey),
  });
  if (typeof messageId === "number") {
    pendingApprovals.set(toolCallId, {
      chatId,
      messageId,
      runToken,
      ...(commandKey && { commandKey }),
    });
  }
}

/**
 * Put the agent's question in front of the human with one button per option.
 *
 * A new message rather than an edit of the progress bubble: the bubble is
 * overwritten every couple of seconds and replaced by the answer, so a question
 * living there would vanish before it could be read.
 */
async function sendUserInputRequest(
  config: BridgeConfig,
  chatId: number,
  runToken: string,
  event: JazzEvent,
): Promise<void> {
  const requestId = event.requestId;
  const question = event.question?.trim();
  if (requestId === undefined || !question) return;

  const suggestions = event.suggestions ?? [];
  const lines = ["❓ <b>The agent needs an answer</b>", escapeHtml(question)];
  for (const suggestion of suggestions) {
    if (suggestion.description) {
      lines.push(
        `• <b>${escapeHtml(suggestion.label ?? suggestion.value)}</b> — ${escapeHtml(suggestion.description)}`,
      );
    }
  }

  // The value is what the agent gets back; the label is only ever shown. Sending
  // an index keeps the callback payload inside Telegram's 64-byte limit however
  // long the option text is.
  const buttons = suggestions.map((suggestion, index) => ({
    text: (suggestion.label ?? suggestion.value).slice(0, 60),
    callback_data: `q:${requestId}:${index}`,
  }));
  const rows: Record<string, unknown>[][] = buttons.map((button) => [button]);

  const messageId = await sendReply(config, chatId, lines.join("\n"), {
    markup: { inline_keyboard: rows },
  });
  if (typeof messageId === "number") {
    pendingUserInputs.set(requestId, {
      chatId,
      messageId,
      runToken,
      options: suggestions.map((suggestion) => suggestion.value),
    });
  }
}

// --- Jazz invocation ------------------------------------------------------

async function runJazz(
  config: BridgeConfig,
  chatId: number,
  prompt: string,
  onEvent: (event: JazzEvent) => void,
  runToken: string,
): Promise<JazzEnvelope> {
  const incognito = isIncognito(config.jazzHome, INCOGNITO_FILE, chatId);
  const priorIncognitoMessages = incognito ? incognitoHistory.get(chatId) : undefined;
  const child = Bun.spawn(
    [
      config.jazzBinary,
      "run",
      "--no-tui",
      "--json",
      "--events",
      "tools,reasoning,text,approval,subagent",
      "--interactive-stdin",
      "--agent",
      agentIdForChat(chatId),
      "--approval-policy",
      config.approvalPolicy,
      ...(config.autoApproveTools.length > 0
        ? ["--auto-approve-tools", config.autoApproveTools.join(",")]
        : []),
      "--timezone",
      tzForChat(config.jazzHome, TZ_FILE, chatId),
      ...(incognito
        ? [
            "--ephemeral",
            ...(priorIncognitoMessages && priorIncognitoMessages.length > 0
              ? ["--history-json", JSON.stringify(priorIncognitoMessages)]
              : []),
          ]
        : ["--conversation", conversationKey(config.jazzHome, EPOCHS_FILE, chatId)]),
      "--timeout",
      String(config.runTimeoutMs),
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "pipe", env: { ...process.env } },
  );
  // Register so the ⏹ Cancel button can find and kill this process.
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
        void sendApprovalRequest(config, chatId, runToken, event).catch((error) =>
          console.error(`Failed to send approval request for chat ${chatId}: ${String(error)}`),
        );
      }
      if (event.type === "user_input_required" && event.requestId) {
        void sendUserInputRequest(config, chatId, runToken, event).catch((error) =>
          console.error(`Failed to send question for chat ${chatId}: ${String(error)}`),
        );
      }
    } catch {
      // Non-event stderr line (plain log chatter) — ignore.
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
    // Carry the transcript forward in memory for this incognito chat's next
    // turn — it never touches disk, so a dropped/missing `messages` field
    // (e.g. the run errored) just means the next turn starts context-free.
    if (incognito && envelope.ok) {
      incognitoHistory.set(chatId, envelope.messages ?? []);
    }
    return envelope;
  } catch (error) {
    console.error(`Failed to parse Jazz envelope: ${String(error)}\nLine: ${lastJsonLine}`);
    return { ok: false, error: "Could not parse the agent response." };
  }
}

/**
 * Deliver a `create_web_app` result: a static chart/diagram is uploaded
 * directly as a photo (no tap needed); an interactive page needs a public URL
 * to open in — falls back to a warning if TELEGRAM_WEBAPP_BASE_URL isn't set.
 */
async function deliverWebApp(
  config: BridgeConfig,
  chatId: number,
  webApp: JazzWebApp,
): Promise<void> {
  if (webApp.mode === "static") {
    if (webApp.imagePath === undefined) {
      console.error(`create_web_app returned static mode with no imagePath (id=${webApp.id})`);
      return;
    }
    await sendPhotoFile(config, chatId, webApp.imagePath, webApp.title);
    return;
  }

  if (config.webAppBaseUrl === undefined) {
    await sendReply(
      config,
      chatId,
      "⚠️ Generated an interactive UI, but no public URL is configured for this bot " +
        "(set <code>TELEGRAM_WEBAPP_BASE_URL</code>) — can't open it.",
    );
    return;
  }

  const url = `${config.webAppBaseUrl}/webapps/${webApp.id}`;
  await sendReply(config, chatId, `Tap to open: <b>${escapeHtml(webApp.title)}</b>`, {
    markup: webAppKeyboard(url, webApp.title),
  });
}

async function handleMessage(config: BridgeConfig, chatId: number, text: string): Promise<void> {
  ensureChatAgent(config.jazzHome, chatId, config.baseAgentId);

  const usage = todayUsage(config.jazzHome, USAGE_FILE);
  const capBlockReason = dailyCostCapBlockReason(usage, config.dailyCostCapUsd);
  if (capBlockReason === "unpriced") {
    await sendReply(
      config,
      chatId,
      "⚠️ Daily cost cap paused: pricing was unavailable for an earlier run today, so spend cannot be verified. Try again tomorrow, disable the cap, or select a priced model.",
    );
    return;
  }

  if (capBlockReason === "reached") {
    await sendReply(
      config,
      chatId,
      `⚠️ Daily cost cap ($${config.dailyCostCapUsd.toFixed(2)}) reached. Try again tomorrow, or raise JAZZ_DAILY_COST_CAP_USD.`,
    );
    return;
  }

  await callTelegram(config, "sendChatAction", { chat_id: chatId, action: "typing" });

  const runToken = newRunToken();
  // A live-updated progress bubble with a ⏹ Cancel button. The final answer is
  // sent as a *new* message so it pushes a notification (edits don't).
  const sent = (await callTelegram(config, "sendMessage", {
    chat_id: chatId,
    text: PROGRESS_INITIAL_TEXT,
    parse_mode: "HTML",
    reply_markup: cancelKeyboard(runToken),
  })) as { result?: { message_id?: number } } | undefined;
  const messageId = sent?.result?.message_id;
  // Opened before the run so a crash or timeout still leaves a record: the
  // conversation transcript is only written once a run completes.
  const runLog = createRunLog(
    config.jazzHome,
    conversationKey(config.jazzHome, EPOCHS_FILE, chatId),
  );
  let runLogged = false;
  const reporter =
    typeof messageId === "number"
      ? createProgressReporter(config, chatId, messageId, runToken, runLog)
      : undefined;

  try {
    const envelope = await runJazz(
      config,
      chatId,
      text,
      (event) => reporter?.onEvent(event),
      runToken,
    );
    const cancelled = activeRuns.get(runToken)?.cancelled ?? false;
    runLog.finish({
      ok: envelope.ok,
      cancelled,
      rounds: reporter?.rounds() ?? 0,
      toolsUsed: reporter?.toolsUsed() ?? [],
      ...(envelope.ok ? {} : { error: envelope.error }),
    });
    runLogged = true;

    if (cancelled) {
      await reporter?.finish("⏹ <b>Cancelled</b>");
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
        USAGE_FILE,
        envelope.costUSD,
        envelope.tokenUsage?.totalTokens ?? 0,
        costKnown,
      );
      const used = reporter?.toolsUsed() ?? [];
      const parts = ["✅ <b>Done</b>"];
      if (used.length > 0) {
        parts.push(used.map((tool) => `<code>${escapeHtml(tool)}</code>`).join(" "));
      }
      if (envelope.costUSD > 0) {
        parts.push(envelope.costUSD >= 0.0001 ? `$${envelope.costUSD.toFixed(4)}` : "<$0.0001");
      } else if (!costKnown) {
        parts.push("price unavailable");
      }
      const usageLines = formatUsageLines(envelope.tokenUsage);
      await reporter?.finish(
        usageLines === undefined ? parts.join(" · ") : `${parts.join(" · ")}\n\n${usageLines}`,
      );
      // Send with static CTAs immediately, then (optionally) upgrade to
      // contextual ones once a quick follow-up generation returns.
      const answerMessageId = await sendReply(config, chatId, envelope.answer, {
        markdown: true,
        markup: followupKeyboard(),
      });
      if (config.dynamicCta && answerMessageId !== undefined) {
        void upgradeToDynamicCtas(config, chatId, answerMessageId, text, envelope.answer);
      }
      if (config.showReasoning) {
        await sendReasoningLog(config, chatId, reporter?.reasoningLog() ?? "");
      }
      if (envelope.webApp) {
        await deliverWebApp(config, chatId, envelope.webApp);
      }
    } else {
      await reporter?.finish("⚠️ <b>Failed</b>");
      await sendReply(config, chatId, `⚠️ ${escapeHtml(envelope.error)}`);
    }
  } finally {
    // A throw anywhere above would otherwise leave the log with no outcome line,
    // which is exactly the run someone will come looking for.
    if (!runLogged) {
      runLog.finish({
        ok: false,
        error: "handler threw before the run reported an outcome",
        rounds: reporter?.rounds() ?? 0,
        toolsUsed: reporter?.toolsUsed() ?? [],
      });
    }
    // Always release the run slot, even if runJazz or a reply throws.
    activeRuns.delete(runToken);
    // Sweep any approvals left pending for this run (e.g. the run finished or
    // errored before a human tapped Accept/Reject).
    for (const [toolCallId, pending] of pendingApprovals) {
      if (pending.runToken === runToken) pendingApprovals.delete(toolCallId);
    }
    for (const [requestId, pending] of pendingUserInputs) {
      if (pending.runToken === runToken) pendingUserInputs.delete(requestId);
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

// --- Dynamic contextual CTAs ----------------------------------------------

interface Suggestion {
  label: string;
  prompt: string;
}

const SUGGESTION_STORE_MAX = 500;
// callback_data can't hold a full prompt (64-byte cap), so suggestions live
// here keyed by a token; the button carries just the token + index.
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

function suggestionKeyboard(token: string, items: Suggestion[]): Record<string, unknown> {
  return {
    inline_keyboard: items.map((item, index) => [
      { text: item.label, callback_data: `s:${token}:${index}` },
    ]),
  };
}

/** One-shot, stateless `jazz run --json` (no progress/events/history). */
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

const SUGGEST_AGENT_ID = "tg_suggest";

/**
 * A tool-less clone of the template agent used only to generate CTAs. Dropping
 * the tool schemas cuts the prompt from ~11k tokens to a few hundred, so the
 * button upgrade lands in a couple of seconds instead of ~20.
 */
function ensureSuggestAgent(config: BridgeConfig): void {
  if (existsSync(agentPath(config.jazzHome, SUGGEST_AGENT_ID))) return;
  const template = readAgentFile(config.jazzHome, config.baseAgentId);
  template.id = SUGGEST_AGENT_ID;
  template.name = SUGGEST_AGENT_ID;
  template.config["tools"] = [];
  template.config.reasoningEffort = "disable";
  writeAgentFile(config.jazzHome, template);
}

/** Ask the model for 2-4 contextual next-step CTAs based on the exchange. */
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

/** Replace the static follow-up buttons on an answer with contextual ones. */
async function upgradeToDynamicCtas(
  config: BridgeConfig,
  chatId: number,
  messageId: number,
  question: string,
  answer: string,
): Promise<void> {
  try {
    const items = await generateSuggestions(config, question, answer);
    console.log(`[cta] chat ${chatId}: ${items.length} contextual suggestion(s)`);
    if (items.length === 0) return; // keep the static fallback already attached
    const token = storeSuggestions(items);
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: suggestionKeyboard(token, items),
    });
  } catch (error) {
    console.error(`Dynamic CTA generation failed: ${String(error)}`);
  }
}

// --- Commands & inline keyboards ------------------------------------------

/**
 * Registered with Telegram via `setMyCommands` so these show up in the
 * client's "/" autocomplete menu — separate from, and kept in sync by hand
 * with, the prose list in HELP_TEXT below. `command` must be lowercase
 * letters/digits/underscores only (no slash, no arguments).
 */
const BOT_COMMANDS: { command: string; description: string }[] = [
  {
    command: "model",
    description: "Pick an Ollama model, or set provider/model, e.g. anthropic/claude-sonnet-5",
  },
  { command: "persona", description: "Pick my persona / style" },
  { command: "new", description: "Start a fresh conversation (clears earlier context)" },
  { command: "incognito", description: "Start a private conversation (nothing saved) until /new" },
  { command: "remind", description: "Set a reminder, e.g. /remind 30m take pizza out" },
  { command: "reminders", description: "List and cancel your reminders" },
  { command: "tz", description: "Set your timezone, e.g. /tz Europe/Paris" },
  { command: "status", description: "Model, today's usage, uptime" },
  { command: "help", description: "Show available commands" },
];

const HELP_TEXT = [
  "I'm your Jazz assistant. Just send a message and I'll answer.",
  "",
  "Commands:",
  "/model — pick an Ollama model, or /model provider/model for any other provider Jazz supports " +
    "(e.g. /model anthropic/claude-sonnet-5)",
  "/persona — pick my persona / style",
  "/new — start a fresh conversation (clears earlier context)",
  "/incognito — start a private conversation (nothing saved to history or memory) until /new",
  "/remind <when> <text> — e.g. /remind 30m take pizza out",
  "  …or just say it: “remind me to call the dentist in 2 hours”, “send reminder next friday 2pm for review”",
  "/reminders — list and cancel your reminders",
  "/tz — set your timezone so reminder times are local (e.g. /tz Europe/Paris)",
  "/status — model, today's usage, uptime",
  "/help — show this",
  "",
  "📍 Share your location (📎 → Location) and I'll tell you where you are, find nearby places, and set your timezone.",
].join("\n");

interface InlineButton {
  text: string;
  callback_data: string;
}

function keyboardFrom(options: string[], current: string, prefix: string): InlineButton[][] {
  return options.map((option, index) => [
    { text: `${option === current ? "✅ " : ""}${option}`, callback_data: `${prefix}:${index}` },
  ]);
}

function remindersFilePath(dataDir: string, chatId: number): string {
  return join(dataDir, "reminders", `${agentIdForChat(chatId)}.json`);
}

/**
 * Synchronous read of this chat's per-agent reminder file, for display only
 * (the /reminders list and /status). Reminders are only ever created or
 * cancelled through the add_reminder/cancel_reminder tools (or, for the
 * inline "cancel" buttons below, the same ReminderServiceImpl those tools use)
 * — never written here.
 */
function readRemindersForDisplay(dataDir: string, chatId: number): ReminderRecord[] {
  try {
    const path = remindersFilePath(dataDir, chatId);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ReminderRecord[]) : [];
  } catch {
    return [];
  }
}

/** Cancel via the same ReminderServiceImpl the cancel_reminder tool uses — the only reminder-cancelling code path. */
async function cancelReminderForChat(
  dataDir: string,
  chatId: number,
  id: string,
): Promise<boolean> {
  const service = new ReminderServiceImpl({ baseReminderDirectory: join(dataDir, "reminders") });
  const outcome = await Effect.runPromise(
    service.cancel(agentIdForChat(chatId), id).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  return outcome.success;
}

async function handleRemind(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const usage =
    "Usage: <code>/remind &lt;when&gt; &lt;text&gt;</code>\n" +
    "Examples: <code>/remind 30m take pizza out</code>, <code>/remind 1h30m stretch</code>, " +
    "<code>/remind 18:00 standup</code>, <code>/remind tomorrow 09:00 gym</code>, " +
    "<code>/remind 2026-08-25 20:00 pack shoes</code>";
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    await sendReply(config, chatId, usage);
    return;
  }

  // Route through a normal full agent turn — the add_reminder tool (not this
  // handler) does the actual time parsing and scheduling, so there is exactly
  // one code path that creates reminders regardless of how the request arrived.
  await handleMessage(config, chatId, `Add a reminder: ${trimmed}`);
}

async function handleTz(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const requested = args.trim();
  if (requested.length === 0) {
    const current = tzForChat(config.jazzHome, TZ_FILE, chatId);
    const suffix = hasChatTz(config.jazzHome, TZ_FILE, chatId)
      ? ""
      : " (default — not set by you yet)";
    await sendReply(
      config,
      chatId,
      `🌍 Your timezone: <code>${escapeHtml(current)}</code>${suffix}\n` +
        `Local time now: ${formatWhen(Date.now(), current)}\n\n` +
        "Change it with <code>/tz Europe/Paris</code> (an IANA name like " +
        "<code>America/New_York</code>, <code>Asia/Tokyo</code>), or just share your location " +
        "(📎 → Location) and I'll set it for you.",
    );
    return;
  }
  if (!isValidTimeZone(requested)) {
    await sendReply(
      config,
      chatId,
      `I don't recognise “${escapeHtml(requested)}”. Use an IANA name such as ` +
        "<code>Europe/Paris</code>, <code>America/New_York</code>, or <code>Asia/Tokyo</code>.",
    );
    return;
  }
  setTzForChat(config.jazzHome, TZ_FILE, chatId, requested);
  await sendReply(
    config,
    chatId,
    `✅ Timezone set to <code>${escapeHtml(requested)}</code>. Local time now: ` +
      `${formatWhen(Date.now(), requested)}.\nReminders will use this from now on.`,
  );
}

async function handleCommand(
  config: BridgeConfig,
  chatId: number,
  command: string,
  args: string,
): Promise<void> {
  const agent = ensureChatAgent(config.jazzHome, chatId, config.baseAgentId);

  if (command === "remind") {
    await handleRemind(config, chatId, args);
    return;
  }

  if (command === "tz" || command === "timezone") {
    await handleTz(config, chatId, args);
    return;
  }

  if (command === "reminders") {
    const mine = readRemindersForDisplay(config.jazzHome, chatId).sort(
      (left, right) => left.fireAt - right.fireAt,
    );
    if (mine.length === 0) {
      await sendReply(
        config,
        chatId,
        "No reminders set. Use <code>/remind &lt;when&gt; &lt;text&gt;</code>.",
      );
      return;
    }
    const tz = tzForChat(config.jazzHome, TZ_FILE, chatId);
    const rows = mine.map((reminder) => [
      {
        text: `❌ ${formatWhen(reminder.fireAt, tz)} — ${reminder.text.slice(0, 24)}`,
        callback_data: `r:${reminder.id}`,
      },
    ]);
    await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: `Pending reminders (tap to cancel · times in ${tz}):`,
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (command === "new" || command === "reset") {
    const wasIncognito = isIncognito(config.jazzHome, INCOGNITO_FILE, chatId);
    if (wasIncognito) {
      setIncognito(config.jazzHome, INCOGNITO_FILE, chatId, false);
      incognitoHistory.delete(chatId);
    }
    startNewConversation(config.jazzHome, EPOCHS_FILE, chatId);
    await sendReply(
      config,
      chatId,
      wasIncognito
        ? "🆕 Incognito conversation ended and discarded. Back to normal — your model and persona stay the same."
        : "🆕 Fresh conversation — I've cleared the earlier context. Your model and persona stay the same.",
    );
    return;
  }

  if (command === "incognito") {
    setIncognito(config.jazzHome, INCOGNITO_FILE, chatId, true);
    incognitoHistory.delete(chatId);
    await sendReply(
      config,
      chatId,
      "🕶️ Incognito mode on — nothing from this conversation is saved to history or memory. Send /new to end it.",
    );
    return;
  }

  if (command === "status") {
    const day = todayUsage(config.jazzHome, USAGE_FILE);
    const cap = config.dailyCostCapUsd;
    const lines = [
      "📊 <b>Status</b>",
      ...(isIncognito(config.jazzHome, INCOGNITO_FILE, chatId)
        ? ["🕶️ Incognito — nothing being saved right now"]
        : []),
      `Model: <code>${escapeHtml(agent.config.llmProvider)}/${escapeHtml(agent.config.llmModel)}</code> (reasoning: ${escapeHtml(agent.config.reasoningEffort)})`,
      `Timezone: <code>${escapeHtml(tzForChat(config.jazzHome, TZ_FILE, chatId))}</code>${hasChatTz(config.jazzHome, TZ_FILE, chatId) ? "" : " (default)"}`,
      `Today: ${day.runs} runs · ${formatTokenCount(day.tokens)} tok · $${day.costUSD.toFixed(4)}${(day.unpricedRuns ?? 0) > 0 ? ` · ${day.unpricedRuns} unpriced` : ""}`,
      `Daily cap: ${cap > 0 ? `$${cap.toFixed(2)}` : "none"}`,
      `Uptime: ${formatUptime(Date.now() - BRIDGE_STARTED_AT)}`,
    ];
    await sendReply(config, chatId, lines.join("\n"));
    return;
  }

  if (command === "model") {
    const requested = args.trim();
    if (requested.length > 0) {
      const parsed = parseProviderModel(requested);
      if (parsed === null) {
        await sendReply(
          config,
          chatId,
          `⚠️ Usage: <code>/model provider/model</code>, e.g. <code>/model openai/gpt-5.2</code>.\n` +
            `Providers: ${AVAILABLE_PROVIDERS.join(", ")}`,
        );
        return;
      }
      const metadata = await getModelsDevMetadata(parsed.model, parsed.provider);
      agent.config.llmProvider = parsed.provider;
      agent.config.llmModel = parsed.model;
      if (metadata !== undefined) {
        agent.config.reasoningEffort = metadata.isReasoningModel ? "medium" : "disable";
      }
      writeAgentFile(config.jazzHome, agent);
      await sendReply(
        config,
        chatId,
        `✅ Model → ${parsed.provider}/${parsed.model}` +
          (metadata !== undefined
            ? `\nReasoning: ${agent.config.reasoningEffort}`
            : "\n⚠️ Unknown model in the catalog — reasoning setting left unchanged."),
      );
      return;
    }

    const provider = agent.config.llmProvider;
    if (!(AVAILABLE_PROVIDERS as readonly string[]).includes(provider)) {
      await sendReply(
        config,
        chatId,
        `⚠️ Unknown provider <code>${escapeHtml(provider)}</code> on this chat's agent. ` +
          "Set one with <code>/model provider/model</code>.",
      );
      return;
    }
    const models = await listModelsForProvider(provider as ProviderName);
    if (models.length === 0) {
      await sendReply(
        config,
        chatId,
        `⚠️ No models available for <code>${escapeHtml(provider)}</code> right now — check its ` +
          "API key is set. Switch provider directly with <code>/model provider/model</code>, " +
          "e.g. <code>/model openai/gpt-5.2</code>.",
      );
      return;
    }
    await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: `Pick a ${provider} model, or send /model provider/model to switch provider:`,
      reply_markup: {
        inline_keyboard: keyboardFrom(
          models.map((model) => model.id),
          agent.config.llmModel,
          "m",
        ),
      },
    });
    return;
  }

  if (command === "persona") {
    const personas = await listPersonas(config);
    await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: "Pick a persona:",
      reply_markup: { inline_keyboard: keyboardFrom(personas, agent.config.persona, "p") },
    });
    return;
  }

  await sendReply(config, chatId, HELP_TEXT);
}

interface CallbackQuery {
  readonly id?: string;
  readonly data?: string;
  readonly message?: { readonly message_id?: number; readonly chat?: { readonly id?: number } };
  readonly from?: { readonly id?: number };
}

async function handleCallback(config: BridgeConfig, callback: CallbackQuery): Promise<void> {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = callback.data;
  if (typeof chatId !== "number" || typeof messageId !== "number" || typeof data !== "string") {
    return;
  }
  if (!config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring callback from non-allowed chat ${chatId}`);
    return;
  }

  const parts = data.split(":");
  const kind = parts[0];
  const indexRaw = parts[1];

  if (kind === "s") {
    const items = suggestionStore.get(parts[1] ?? "");
    const index = Number.parseInt(parts[2] ?? "", 10);
    const item = items !== undefined && Number.isInteger(index) ? items[index] : undefined;
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(item ? {} : { text: "That suggestion expired — just ask me directly." }),
    });
    if (!item) return;
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    await sendReply(config, chatId, escapeHtml(item.label));
    void handleMessage(config, chatId, item.prompt).catch((error) =>
      console.error(`Suggestion follow-up failed for chat ${chatId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "x") {
    const runToken = indexRaw ?? "";
    const run = activeRuns.get(runToken);
    if (run) {
      run.cancelled = true;
      run.child.kill();
    }
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: run ? "Cancelling…" : "Already finished.",
    });
    // A cancelled run can no longer answer pending approvals — sweep them so a
    // stale Accept/Reject tap gets "already expired" instead of writing to a
    // dead pipe, and best-effort clear their keyboards.
    for (const [toolCallId, pending] of pendingApprovals) {
      if (pending.runToken !== runToken) continue;
      pendingApprovals.delete(toolCallId);
      await callTelegram(config, "editMessageReplyMarkup", {
        chat_id: pending.chatId,
        message_id: pending.messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    }
    return;
  }

  if (kind === "q") {
    const requestId = parts[1] ?? "";
    const optionIndex = Number.parseInt(parts[2] ?? "", 10);
    const pending = pendingUserInputs.get(requestId);
    const run = pending ? activeRuns.get(pending.runToken) : undefined;
    const answer = pending?.options[optionIndex];
    if (!pending || !run || answer === undefined) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This question already expired or the run finished.",
      });
      return;
    }
    pendingUserInputs.delete(requestId);
    try {
      // The run is parked on stdin waiting for exactly this line; flush rather
      // than let Bun's FileSink hold it until the buffer fills.
      await run.child.stdin.write(
        `${JSON.stringify({ type: "user_input_response", requestId, response: answer })}\n`,
      );
      await run.child.stdin.flush();
    } catch (error) {
      console.error(`Failed to write user input response: ${String(error)}`);
    }
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Answered: ${answer}`.slice(0, 200),
    });
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (kind === "a") {
    const toolCallId = parts[1] ?? "";
    const decision = parts[2];
    const approved = decision === "1" || decision === "2";
    const always = decision === "2";
    const pending = pendingApprovals.get(toolCallId);
    const run = pending ? activeRuns.get(pending.runToken) : undefined;
    if (!pending || !run) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This approval already expired or the run finished.",
      });
      return;
    }
    pendingApprovals.delete(toolCallId);
    try {
      // Bun's FileSink buffers writes; flush() pushes it through the pipe now
      // rather than waiting for the buffer to fill on its own.
      await run.child.stdin.write(
        `${JSON.stringify({ type: "approval_decision", toolCallId, approved })}\n`,
      );
      await run.child.stdin.flush();
    } catch (error) {
      console.error(`Failed to write approval decision: ${String(error)}`);
    }
    if (always && pending.commandKey) {
      await addAutoApprovedCommand(config.jazzHome, pending.commandKey).catch((error: unknown) =>
        console.error(`Failed to persist auto-approved command: ${String(error)}`),
      );
    }
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: always
        ? `Approved — "${pending.commandKey}" always allowed from now on`
        : approved
          ? "Approved"
          : "Rejected",
    });
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (kind === "f") {
    const option = FOLLOWUP_OPTIONS[indexRaw ?? ""];
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(option ? {} : { text: "Unknown action" }),
    });
    if (!option) return;
    // Drop the follow-up buttons so they can't be tapped twice.
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    await sendReply(config, chatId, option.label);
    void handleMessage(config, chatId, option.prompt).catch((error) =>
      console.error(`Follow-up failed for chat ${chatId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "r") {
    const cancelled = await cancelReminderForChat(config.jazzHome, chatId, indexRaw ?? "");
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: cancelled ? "Reminder cancelled" : "Not found",
    });
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  const index = Number.parseInt(indexRaw ?? "", 10);
  const agent = ensureChatAgent(config.jazzHome, chatId, config.baseAgentId);
  let confirmation: string;

  if (kind === "m") {
    const models = await listModelsForProvider(agent.config.llmProvider as ProviderName);
    const choice = Number.isInteger(index) ? models[index] : undefined;
    if (choice === undefined) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "That list changed — run /model again.",
      });
      return;
    }
    const reasoning = choice.isReasoningModel ? "medium" : "disable";
    agent.config.llmModel = choice.id;
    agent.config.reasoningEffort = reasoning;
    writeAgentFile(config.jazzHome, agent);
    confirmation = `✅ Model → ${choice.id}\nReasoning: ${reasoning}`;
  } else if (kind === "p") {
    const personas = await listPersonas(config);
    const persona = Number.isInteger(index) ? personas[index] : undefined;
    if (persona === undefined) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "That list changed — run /persona again.",
      });
      return;
    }
    agent.config.persona = persona;
    writeAgentFile(config.jazzHome, agent);
    confirmation = `✅ Persona → ${persona}`;
  } else {
    await callTelegram(config, "answerCallbackQuery", { callback_query_id: callback.id });
    return;
  }

  await callTelegram(config, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Saved",
  });
  await callTelegram(config, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: confirmation,
    reply_markup: { inline_keyboard: [] },
  });
}

// --- Dispatch -------------------------------------------------------------

interface TelegramMessage {
  readonly chat?: { readonly id?: number };
  readonly from?: {
    readonly first_name?: string;
    readonly username?: string;
    readonly is_bot?: boolean;
  };
  readonly text?: string;
  /** The message this one replies to, when the user used Telegram's reply action. */
  readonly reply_to_message?: TelegramMessage;
  /** The fragment the user highlighted before replying, when they quoted only part of it. */
  readonly quote?: { readonly text?: string };
  readonly location?: { readonly latitude?: number; readonly longitude?: number };
  /** Caption on a media message — the user's actual request, when they wrote one. */
  readonly caption?: string;
  /** A voice note, i.e. the record button. Always OGG/Opus, never has a filename. */
  readonly voice?: TelegramFileRef;
  /** An audio file sent as music, which Telegram treats separately from a voice note. */
  readonly audio?: TelegramFileRef;
  /**
   * Photos arrive as an array of the same image at several resolutions, smallest first.
   * The last entry is the largest Telegram kept.
   */
  readonly photo?: readonly TelegramFileRef[];
  /** Any file sent as a document, including images sent with "send as file". */
  readonly document?: TelegramFileRef;
}

/**
 * Media on a message, plus what to ask jazz when the user sent no caption.
 *
 * Voice notes get an explicit transcribe-and-act instruction because a bare voice note with no
 * caption is the single most common case, and the model needs to know it should act on what was
 * said rather than just describe the audio.
 */
function extractMedia(
  message: TelegramMessage,
): { file: TelegramFileRef; fallbackInstruction: string } | undefined {
  if (message.voice !== undefined) {
    return {
      file: message.voice,
      fallbackInstruction:
        "This is a voice message. Listen to it, then do what it asks — or answer it if it is a question.",
    };
  }
  if (message.audio !== undefined) {
    return {
      file: message.audio,
      fallbackInstruction: "Listen to this audio and tell me what is in it.",
    };
  }
  if (message.photo !== undefined && message.photo.length > 0) {
    // Largest available resolution: the smaller entries are thumbnails and would waste the
    // request on an unreadable image.
    const largest = message.photo[message.photo.length - 1];
    if (largest !== undefined) {
      return {
        file: largest,
        fallbackInstruction: "Look at this image and tell me what it shows.",
      };
    }
  }
  if (message.document !== undefined) {
    return {
      file: message.document,
      fallbackInstruction: "Look at this file and tell me what is in it.",
    };
  }
  return undefined;
}

/**
 * Download a media message and hand it to jazz as a path in the prompt.
 *
 * A download failure is reported to the chat rather than swallowed: the user watched their voice
 * note upload and will otherwise be left waiting on a reply that never comes.
 */
async function handleMedia(
  config: BridgeConfig,
  chatId: number,
  message: TelegramMessage,
  media: { file: TelegramFileRef; fallbackInstruction: string },
): Promise<void> {
  const outcome = await downloadTelegramFile(
    config.botToken,
    config.jazzHome,
    media.file,
    chatId,
    Date.now(),
  );
  if (!outcome.ok) {
    await sendReply(config, chatId, `⚠️ I couldn't fetch that file — ${outcome.reason}.`);
    return;
  }
  await handleMessage(
    config,
    chatId,
    withReplyContext(
      message,
      buildMediaPrompt(outcome.path, message.caption, media.fallbackInstruction),
    ),
  );
}

interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: CallbackQuery;
}

function parseCommand(text: string): { command: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text.trim());
  const command = match?.[1];
  if (command === undefined) return undefined;
  return { command: command.toLowerCase(), args: (match?.[2] ?? "").trim() };
}

function dispatchMessage(config: BridgeConfig, message: TelegramMessage | undefined): void {
  const chatId = message?.chat?.id;
  if (typeof chatId !== "number") return;
  if (!config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring message from non-allowed chat ${chatId}`);
    return;
  }

  const text = message?.text?.trim();
  const latitude = message?.location?.latitude;
  const longitude = message?.location?.longitude;

  let work: Promise<void> | undefined;
  if (typeof text === "string" && text.length > 0) {
    const parsed = parseCommand(text);
    work =
      parsed !== undefined
        ? handleCommand(config, chatId, parsed.command, parsed.args)
        : handleMessage(config, chatId, withReplyContext(message ?? {}, text));
  } else if (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
  ) {
    work = handleLocation(config, chatId, latitude, longitude);
  } else {
    const media = extractMedia(message ?? {});
    if (media !== undefined) {
      work = handleMedia(config, chatId, message ?? {}, media);
    }
  }

  // Other message types (stickers, contacts, …) aren't handled yet.
  if (work === undefined) return;

  work.catch((error) => {
    console.error(`Handling failed for chat ${chatId}: ${String(error)}`);
    // Guard the notification itself so a failed reply can't become an
    // unhandled rejection.
    void sendReply(config, chatId, "⚠️ Something went wrong handling your message.").catch(
      (replyError) => console.error(`Failed to notify chat ${chatId}: ${String(replyError)}`),
    );
  });
}

function dispatchUpdate(config: BridgeConfig, update: TelegramUpdate): void {
  if (update.message !== undefined) {
    dispatchMessage(config, update.message);
  }
  if (update.callback_query !== undefined) {
    handleCallback(config, update.callback_query).catch((error) => {
      console.error(`Callback handling failed: ${String(error)}`);
    });
  }
}

// --- Transports -----------------------------------------------------------

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

      if (
        config.mode === "webhook" &&
        request.method === "POST" &&
        url.pathname === "/telegram/webhook"
      ) {
        const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
        if (providedSecret !== config.webhookSecret) {
          return new Response("forbidden", { status: 403 });
        }
        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return new Response("bad request", { status: 400 });
        }
        dispatchUpdate(config, update);
        return new Response("ok", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Health server listening on :${config.port}`);
}

async function registerWebhook(config: BridgeConfig): Promise<void> {
  if (config.webhookUrl === undefined || config.webhookSecret.length === 0) {
    throw new Error("webhook mode requires TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET");
  }
  await callTelegram(config, "setWebhook", {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: true,
  });
  console.log(`Registered Telegram webhook → ${config.webhookUrl}`);
}

async function pollLoop(config: BridgeConfig): Promise<void> {
  // Polling and webhooks are mutually exclusive on Telegram's side.
  await callTelegram(config, "deleteWebhook", { drop_pending_updates: true });
  console.log("Polling Telegram for updates…");

  let offset = 0;
  for (;;) {
    try {
      const response = (await callTelegram(config, "getUpdates", {
        offset,
        timeout: GETUPDATES_TIMEOUT_SECONDS,
        allowed_updates: ALLOWED_UPDATES,
      })) as { ok?: boolean; result?: TelegramUpdate[] } | undefined;

      if (response?.ok !== true) {
        // Fall into the catch so we back off instead of tight-looping on a
        // persistent failure (bad token, 409 conflict, rate limit, …).
        throw new Error("getUpdates returned a non-ok response");
      }

      for (const update of response.result ?? []) {
        if (typeof update.update_id === "number") {
          offset = update.update_id + 1;
        }
        dispatchUpdate(config, update);
      }
    } catch (error) {
      console.error(`Poll error: ${String(error)}`);
      await Bun.sleep(POLL_ERROR_BACKOFF_MS);
    }
  }
}

/** The bot's own display name, used as the agent name the persona speaks as. */
async function fetchBotName(config: BridgeConfig): Promise<string | undefined> {
  const body = (await callTelegram(config, "getMe", {})) as
    { result?: { first_name?: string; username?: string } } | undefined;
  return body?.result?.first_name ?? body?.result?.username;
}

async function start(): Promise<void> {
  const config = loadConfig();
  // Drop the cached CTA agent so it re-seeds from the current template (picks
  // up a changed default model on redeploy); ensureSuggestAgent recreates it.
  rmSync(agentPath(config.jazzHome, SUGGEST_AGENT_ID), { force: true });
  startHealthServer(config);
  startReminderSweep(config.jazzHome, (reminderChatId, html) =>
    sendReply(config, reminderChatId, html),
  );
  // Populates Telegram's "/" autocomplete menu. Cheap and idempotent, so it's
  // just re-sent on every start rather than only when BOT_COMMANDS changes.
  await callTelegram(config, "setMyCommands", { commands: BOT_COMMANDS });
  const botName = await fetchBotName(config);
  if (botName !== undefined) {
    syncAgentDisplayName(config.jazzHome, config.baseAgentId, botName);
  }
  console.log(
    `Telegram → Jazz bridge started as ${botName ?? "an unnamed bot"} (mode="${config.mode}", per-chat agents, policy="${config.approvalPolicy}")`,
  );

  if (config.mode === "webhook") {
    await registerWebhook(config);
  } else {
    await pollLoop(config);
  }
}

start().catch((error) => {
  console.error(`Bridge failed to start: ${String(error)}`);
  process.exit(1);
});

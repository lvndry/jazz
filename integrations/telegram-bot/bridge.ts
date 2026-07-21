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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TELEGRAM_API_BASE = "https://api.telegram.org";
// Telegram's hard limit is 4096; split lower so HTML tags/entities added by
// markdown rendering can't push a chunk over the limit.
const TELEGRAM_SPLIT_LENGTH = 3500;
const GETUPDATES_TIMEOUT_SECONDS = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;
const ALLOWED_UPDATES = ["message", "callback_query"];
// Telegram rate-limits message edits; don't refresh the progress bubble faster.
const PROGRESS_MIN_INTERVAL_MS = 2_000;
const PROGRESS_MAX_TOOLS_SHOWN = 8;
const PROGRESS_REASONING_CHARS = 180;

const BRIDGE_STARTED_AT = Date.now();
// In-flight runs keyed by a per-run token, so the ⏹ Cancel button can kill the
// right jazz process.
const activeRuns = new Map<string, { child: Bun.Subprocess; cancelled: boolean }>();

type TransportMode = "polling" | "webhook";

interface BridgeConfig {
  readonly botToken: string;
  readonly mode: TransportMode;
  readonly webhookSecret: string;
  readonly webhookUrl: string | undefined;
  readonly allowedChatIds: ReadonlySet<number>;
  readonly baseAgentId: string;
  readonly approvalPolicy: string;
  readonly runTimeoutMs: number;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly ollamaBaseUrl: string;
  readonly builtinPersonasDir: string;
  readonly port: number;
  /** Per-day spend ceiling in USD across all chats; 0 disables the cap. */
  readonly dailyCostCapUsd: number;
  /** Reverse-geocoder base URL for shared locations; empty string disables it. */
  readonly geocodeUrl: string;
  /** Generate contextual follow-up CTAs per answer (a second short LLM call). */
  readonly dynamicCta: boolean;
}

interface AgentConfig {
  llmProvider: string;
  llmModel: string;
  reasoningEffort: string;
  persona: string;
  [key: string]: unknown;
}

interface AgentFile {
  id: string;
  name: string;
  model: string;
  config: AgentConfig;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface JazzSuccessEnvelope {
  readonly ok: true;
  readonly answer: string;
  readonly costUSD: number;
  readonly tokenUsage?: { readonly totalTokens?: number };
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

  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    mode,
    webhookSecret: process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim() || "",
    webhookUrl: process.env["TELEGRAM_WEBHOOK_URL"]?.trim() || undefined,
    allowedChatIds,
    baseAgentId: process.env["JAZZ_TELEGRAM_AGENT"]?.trim() || "telegram",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || "jazz",
    jazzHome: process.env["JAZZ_HOME"]?.trim() || "/data",
    ollamaBaseUrl: process.env["OLLAMA_BASE_URL"]?.trim() || "http://localhost:11434/api",
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "/opt/jazz/personas",
    port: Number.parseInt(process.env["PORT"]?.trim() || "8080", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    geocodeUrl: process.env["NOMINATIM_BASE_URL"]?.trim() ?? "https://nominatim.openstreetmap.org",
    dynamicCta: !["0", "false", "off"].includes(
      process.env["JAZZ_TELEGRAM_DYNAMIC_CTA"]?.trim().toLowerCase() ?? "",
    ),
  };
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

function isOkResponse(response: unknown): boolean {
  return (
    typeof response === "object" && response !== null && (response as { ok?: boolean }).ok === true
  );
}

// --- Per-chat agent files -------------------------------------------------

function agentIdForChat(chatId: number): string {
  // Group chat ids are negative; keep the id filename/name-safe.
  return `tg_${String(chatId).replace("-", "n")}`;
}

function agentPath(config: BridgeConfig, agentId: string): string {
  return join(config.jazzHome, "agents", `${agentId}.json`);
}

function readAgentFile(config: BridgeConfig, agentId: string): AgentFile {
  return JSON.parse(readFileSync(agentPath(config, agentId), "utf8")) as AgentFile;
}

function writeAgentFile(config: BridgeConfig, agent: AgentFile): void {
  agent.updatedAt = new Date().toISOString();
  writeFileSync(agentPath(config, agent.id), `${JSON.stringify(agent, null, 2)}\n`);
}

/** Ensure a chat has its own agent, cloned from the seeded template on first use. */
function ensureChatAgent(config: BridgeConfig, chatId: number): AgentFile {
  const agentId = agentIdForChat(chatId);
  const path = agentPath(config, agentId);
  if (existsSync(path)) {
    return readAgentFile(config, agentId);
  }
  mkdirSync(join(config.jazzHome, "agents"), { recursive: true });
  const template = readAgentFile(config, config.baseAgentId);
  template.id = agentId;
  template.name = agentId;
  writeAgentFile(config, template);
  return template;
}

// --- Per-chat conversation sessions ---------------------------------------
// A DM has one chat id, so history would grow forever. A per-chat "epoch"
// lets /new rotate to a fresh conversation key (a breakpoint) while the chat's
// agent — and thus its model/persona — stays put. Old segments remain on disk.

function sessionsPath(config: BridgeConfig): string {
  return join(config.jazzHome, "tg-sessions.json");
}

/** Parse the epoch map; returns null when the file is missing or unreadable. */
function loadSessionEpochs(config: BridgeConfig): Record<string, number> | null {
  const path = sessionsPath(config);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // fall through to null (treated as unreadable)
  }
  return null;
}

/** Conversation key for the chat's current session (epoch 0 keeps the raw id). */
function conversationKey(config: BridgeConfig, chatId: number): string {
  const epoch = loadSessionEpochs(config)?.[String(chatId)] ?? 0;
  return epoch > 0 ? `${chatId}-${epoch}` : String(chatId);
}

/** Bump the chat's session epoch so the next run starts a fresh conversation. */
function startNewConversation(config: BridgeConfig, chatId: number): void {
  const path = sessionsPath(config);
  const epochs = loadSessionEpochs(config);
  if (epochs === null && existsSync(path)) {
    // File exists but couldn't be parsed — preserve it rather than clobber
    // every other chat's epoch on the write below.
    try {
      renameSync(path, `${path}.corrupt`);
      console.error(`Corrupt ${path} preserved as ${path}.corrupt`);
    } catch {
      // best effort
    }
  }
  const next = epochs ?? {};
  next[String(chatId)] = (next[String(chatId)] ?? 0) + 1;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

// --- Daily usage tracking -------------------------------------------------

interface DailyUsage {
  costUSD: number;
  tokens: number;
  runs: number;
}

function usagePath(config: BridgeConfig): string {
  return join(config.jazzHome, "tg-usage.json");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readUsage(config: BridgeConfig): Record<string, DailyUsage> {
  try {
    const path = usagePath(config);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, DailyUsage>;
    }
  } catch {
    // ignore — treat as empty
  }
  return {};
}

function todayUsage(config: BridgeConfig): DailyUsage {
  return readUsage(config)[todayKey()] ?? { costUSD: 0, tokens: 0, runs: 0 };
}

function recordUsage(config: BridgeConfig, costUSD: number, tokens: number): void {
  const usage = readUsage(config);
  const key = todayKey();
  const day = usage[key] ?? { costUSD: 0, tokens: 0, runs: 0 };
  usage[key] = {
    costUSD: day.costUSD + costUSD,
    tokens: day.tokens + tokens,
    runs: day.runs + 1,
  };
  // Keep the file bounded — drop entries older than 30 days.
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const date of Object.keys(usage)) {
    if (date < cutoff) delete usage[date];
  }
  try {
    writeFileSync(usagePath(config), `${JSON.stringify(usage, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write usage: ${String(error)}`);
  }
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

// --- Reminders ------------------------------------------------------------

interface Reminder {
  id: string;
  chatId: number;
  fireAt: number;
  text: string;
  createdAt: number;
}

const REMINDER_SWEEP_MS = 20_000;
let reminderSweepRunning = false;

function remindersPath(config: BridgeConfig): string {
  return join(config.jazzHome, "tg-reminders.json");
}

function readReminders(config: BridgeConfig): Reminder[] {
  try {
    const path = remindersPath(config);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed as Reminder[];
  } catch {
    // ignore — treat as empty
  }
  return [];
}

function writeReminders(config: BridgeConfig, reminders: Reminder[]): void {
  try {
    writeFileSync(remindersPath(config), `${JSON.stringify(reminders, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write reminders: ${String(error)}`);
  }
}

function addReminder(config: BridgeConfig, chatId: number, fireAt: number, text: string): void {
  const reminders = readReminders(config);
  reminders.push({ id: newRunToken(), chatId, fireAt, text, createdAt: Date.now() });
  writeReminders(config, reminders);
}

function cancelReminder(config: BridgeConfig, chatId: number, id: string): boolean {
  const reminders = readReminders(config);
  const remaining = reminders.filter(
    (reminder) => !(reminder.id === id && reminder.chatId === chatId),
  );
  if (remaining.length === reminders.length) return false;
  writeReminders(config, remaining);
  return true;
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a "when" spec into an absolute epoch-ms, or null if unparseable.
 * Supports relative durations (30m, 2h, 1h30m, 90s, 1d), a 24h clock time
 * (HH:MM → next occurrence), and "tomorrow HH:MM". Clock times use the
 * container's timezone — set TZ in .env to your own.
 */
function parseWhen(spec: string, now: number): number | null {
  const trimmed = spec.trim().toLowerCase();

  const tomorrow = /^tomorrow\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  const clock = tomorrow ?? /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    const when = new Date(now);
    if (tomorrow) when.setDate(when.getDate() + 1);
    when.setHours(hours, minutes, 0, 0);
    if (!tomorrow && when.getTime() <= now) when.setDate(when.getDate() + 1);
    return when.getTime();
  }

  let totalMs = 0;
  for (const match of trimmed.matchAll(/(\d+)\s*([smhd])/g)) {
    totalMs += Number(match[1]) * (DURATION_UNIT_MS[match[2] ?? ""] ?? 0);
  }
  const leftover = trimmed.replace(/(\d+)\s*([smhd])/g, "").trim();
  if (totalMs > 0 && leftover === "") return now + totalMs;

  return null;
}

async function fireDueReminders(config: BridgeConfig): Promise<void> {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  try {
    const now = Date.now();
    const reminders = readReminders(config);
    const due = reminders.filter((reminder) => reminder.fireAt <= now);
    if (due.length === 0) return;
    // Remove first so a delivery failure can't loop-fire the same reminder.
    writeReminders(
      config,
      reminders.filter((reminder) => reminder.fireAt > now),
    );
    for (const reminder of due) {
      const late = now - reminder.fireAt > 90_000 ? " (delayed)" : "";
      await sendReply(config, reminder.chatId, `⏰ <b>Reminder</b>${late}\n${reminder.text}`);
    }
  } finally {
    reminderSweepRunning = false;
  }
}

function startReminderSweep(config: BridgeConfig): void {
  const sweep = (): void => {
    void fireDueReminders(config).catch((error) =>
      console.error(`Reminder sweep failed: ${String(error)}`),
    );
  };
  sweep(); // deliver anything that came due while the bridge was down
  setInterval(sweep, REMINDER_SWEEP_MS);
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
async function handleLocation(
  config: BridgeConfig,
  chatId: number,
  latitude: number,
  longitude: number,
): Promise<void> {
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

// --- Ollama model discovery -----------------------------------------------

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

/** True if the model advertises a "thinking" capability (so reasoning is safe to enable). */
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

// --- Persona discovery ----------------------------------------------------

function listPersonasIn(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
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
  found.delete("summarizer"); // internal
  const names = [...found];
  if (names.length === 0) {
    return ["default", "coder", "researcher"];
  }
  return names.sort((left, right) => left.localeCompare(right));
}

// --- Markdown → Telegram HTML --------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Convert a subset of Markdown to Telegram's HTML flavor. Code spans/blocks are
 * extracted first so their contents aren't treated as markup, everything else
 * is HTML-escaped, then inline styles map to well-formed tags. The paired-tag
 * regexes only ever emit balanced HTML, so parsing can't fail; sendReply still
 * falls back to plain text on any Telegram error as a belt-and-braces guard.
 */
function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  // Per-call random token in the placeholders so they can't collide with
  // anything the user actually typed.
  const token = Math.random().toString(36).slice(2);
  const placeholder = (kind: string, index: number): string => ` ${kind}_${token}_${index} `;
  const restoreRegex = (kind: string): RegExp => new RegExp(` ${kind}_${token}_(\\d+) `, "g");

  let text = markdown.replace(
    /```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      codeBlocks.push(
        `<pre><code${languageClass}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
      );
      return placeholder("CB", codeBlocks.length - 1);
    },
  );

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder("IC", inlineCodes.length - 1);
  });

  text = escapeHtml(text);
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^\n_]+?)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^*])\*(\S|\S[^\n*]*?\S)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(/~~([^\n~]+?)~~/g, "<s>$1</s>");
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  text = text.replace(
    restoreRegex("IC"),
    (_match, index: string) => inlineCodes[Number(index)] ?? "",
  );
  text = text.replace(
    restoreRegex("CB"),
    (_match, index: string) => codeBlocks[Number(index)] ?? "",
  );
  return text;
}

function splitForTelegram(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return ["(empty response)"];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > TELEGRAM_SPLIT_LENGTH) {
    const window = remaining.slice(0, TELEGRAM_SPLIT_LENGTH);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > TELEGRAM_SPLIT_LENGTH * 0.5 ? lastNewline : window.length;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

function messageIdOf(response: unknown): number | undefined {
  const id = (response as { result?: { message_id?: number } } | undefined)?.result?.message_id;
  return typeof id === "number" ? id : undefined;
}

async function sendReply(
  config: BridgeConfig,
  chatId: number,
  text: string,
  lastMarkup?: Record<string, unknown>,
): Promise<number | undefined> {
  const chunks = splitForTelegram(text);
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const markup = lastMarkup !== undefined && index === chunks.length - 1 ? lastMarkup : undefined;
    const rendered = await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: markdownToTelegramHtml(chunk),
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

function followupKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "🔍 Go deeper", callback_data: "f:deeper" },
        { text: "✂️ Shorter", callback_data: "f:shorter" },
      ],
    ],
  };
}

// --- Live progress --------------------------------------------------------

// A subset of Jazz's NDJSON stream events (jazz run --events); other fields ignored.
interface JazzEvent {
  readonly type: string;
  readonly toolName?: string;
  readonly content?: string;
  readonly approved?: boolean;
  readonly task?: string;
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
 * Show the latest slice of a streaming thought. Short thoughts render whole;
 * longer ones show the tail from a word boundary with a leading ellipsis, so
 * the line reads as a continuation rather than a chopped-off first word.
 */
function reasoningSnippet(reasoning: string): string {
  const normalized = reasoning.replace(/\s+/g, " ").trim();
  if (normalized.length <= PROGRESS_REASONING_CHARS) return normalized;
  let tail = normalized.slice(-PROGRESS_REASONING_CHARS).trimStart();
  const firstSpace = tail.indexOf(" ");
  if (firstSpace > 0 && firstSpace < 40) tail = tail.slice(firstSpace + 1);
  return `… ${tail}`;
}

function createProgressReporter(
  config: BridgeConfig,
  chatId: number,
  messageId: number,
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
      switch (event.type) {
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
  };
}

// --- Jazz invocation ------------------------------------------------------

async function runJazz(
  config: BridgeConfig,
  chatId: number,
  prompt: string,
  onEvent: (event: JazzEvent) => void,
  runToken: string,
): Promise<JazzEnvelope> {
  const child = Bun.spawn(
    [
      config.jazzBinary,
      "run",
      "--no-tui",
      "--json",
      "--events",
      "tools,reasoning,text,approval,subagent",
      "--agent",
      agentIdForChat(chatId),
      "--approval-policy",
      config.approvalPolicy,
      "--conversation",
      conversationKey(config, chatId),
      "--timeout",
      String(config.runTimeoutMs),
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
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
    return JSON.parse(lastJsonLine) as JazzEnvelope;
  } catch (error) {
    console.error(`Failed to parse Jazz envelope: ${String(error)}\nLine: ${lastJsonLine}`);
    return { ok: false, error: "Could not parse the agent response." };
  }
}

async function handleMessage(config: BridgeConfig, chatId: number, text: string): Promise<void> {
  ensureChatAgent(config, chatId);

  if (config.dailyCostCapUsd > 0 && todayUsage(config).costUSD >= config.dailyCostCapUsd) {
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
    text: "🤔 <b>Working…</b>",
    parse_mode: "HTML",
    reply_markup: cancelKeyboard(runToken),
  })) as { result?: { message_id?: number } } | undefined;
  const messageId = sent?.result?.message_id;
  const reporter =
    typeof messageId === "number"
      ? createProgressReporter(config, chatId, messageId, runToken)
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

    if (cancelled) {
      await reporter?.finish("⏹ <b>Cancelled</b>");
      return;
    }

    if (envelope.ok) {
      recordUsage(config, envelope.costUSD, envelope.tokenUsage?.totalTokens ?? 0);
      const used = reporter?.toolsUsed() ?? [];
      const parts = ["✅ <b>Done</b>"];
      if (used.length > 0) {
        parts.push(used.map((tool) => `<code>${escapeHtml(tool)}</code>`).join(" "));
      }
      const totalTokens = envelope.tokenUsage?.totalTokens;
      if (typeof totalTokens === "number" && totalTokens > 0) {
        parts.push(`${formatTokenCount(totalTokens)} tok`);
      }
      if (envelope.costUSD > 0) {
        parts.push(envelope.costUSD >= 0.0001 ? `$${envelope.costUSD.toFixed(4)}` : "<$0.0001");
      }
      await reporter?.finish(parts.join(" · "));
      // Send with static CTAs immediately, then (optionally) upgrade to
      // contextual ones once a quick follow-up generation returns.
      const answerMessageId = await sendReply(config, chatId, envelope.answer, followupKeyboard());
      if (config.dynamicCta && answerMessageId !== undefined) {
        void upgradeToDynamicCtas(config, chatId, answerMessageId, text, envelope.answer);
      }
    } else {
      await reporter?.finish("⚠️ <b>Failed</b>");
      await sendReply(config, chatId, `⚠️ ${envelope.error}`);
    }
  } finally {
    // Always release the run slot, even if runJazz or a reply throws.
    activeRuns.delete(runToken);
  }
}

const FOLLOWUP_PROMPTS: Record<string, string> = {
  deeper:
    "Go deeper on your previous answer: add more detail, concrete specifics, and any important nuances or caveats.",
  shorter:
    "Give a much shorter version of your previous answer — 2-3 sentences, just the essentials.",
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
  const template = readAgentFile(config, config.baseAgentId);
  template.id = SUGGEST_AGENT_ID;
  template.name = SUGGEST_AGENT_ID;
  template.config.tools = [];
  template.config.reasoningEffort = "disable";
  writeAgentFile(config, template);
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

const HELP_TEXT = [
  "I'm your Jazz assistant. Just send a message and I'll answer.",
  "",
  "Commands:",
  "/model — pick which Ollama model I use (just for you)",
  "/persona — pick my persona / style",
  "/new — start a fresh conversation (clears earlier context)",
  "/remind <when> <text> — e.g. /remind 30m take pizza out",
  "/reminders — list & cancel your reminders",
  "/status — model, today's usage, uptime",
  "/help — show this",
  "",
  "📍 Share your location (📎 → Location) and I'll tell you where you are and find nearby places.",
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

async function handleRemind(config: BridgeConfig, chatId: number, args: string): Promise<void> {
  const usage =
    "Usage: <code>/remind &lt;when&gt; &lt;text&gt;</code>\n" +
    "Examples: <code>/remind 30m take pizza out</code>, <code>/remind 1h30m stretch</code>, " +
    "<code>/remind 18:00 standup</code>, <code>/remind tomorrow 09:00 gym</code>";
  const words = args.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    await sendReply(config, chatId, usage);
    return;
  }

  const now = Date.now();
  let fireAt: number | null = null;
  let text = "";
  if (words.length >= 2 && words[0]?.toLowerCase() === "tomorrow") {
    fireAt = parseWhen(`tomorrow ${words[1]}`, now);
    if (fireAt !== null) text = words.slice(2).join(" ");
  }
  if (fireAt === null) {
    fireAt = parseWhen(words[0] ?? "", now);
    if (fireAt !== null) text = words.slice(1).join(" ");
  }

  if (fireAt === null) {
    await sendReply(config, chatId, `I couldn't read the time.\n${usage}`);
    return;
  }
  if (text.trim().length === 0) {
    await sendReply(
      config,
      chatId,
      "What should I remind you about? e.g. <code>/remind 30m call the plumber</code>",
    );
    return;
  }

  addReminder(config, chatId, fireAt, text.trim());
  await sendReply(
    config,
    chatId,
    `⏰ Reminder set — in ${formatUptime(fireAt - now)}.\n“${escapeHtml(text.trim())}”`,
  );
}

async function handleCommand(
  config: BridgeConfig,
  chatId: number,
  command: string,
  args: string,
): Promise<void> {
  const agent = ensureChatAgent(config, chatId);

  if (command === "remind") {
    await handleRemind(config, chatId, args);
    return;
  }

  if (command === "reminders") {
    const mine = readReminders(config)
      .filter((reminder) => reminder.chatId === chatId)
      .sort((left, right) => left.fireAt - right.fireAt);
    if (mine.length === 0) {
      await sendReply(
        config,
        chatId,
        "No reminders set. Use <code>/remind &lt;when&gt; &lt;text&gt;</code>.",
      );
      return;
    }
    const rows = mine.map((reminder) => [
      {
        text: `❌ ${new Date(reminder.fireAt).toISOString().slice(5, 16).replace("T", " ")} — ${reminder.text.slice(0, 24)}`,
        callback_data: `r:${reminder.id}`,
      },
    ]);
    await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: "Pending reminders (tap to cancel · times UTC):",
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (command === "new" || command === "reset") {
    startNewConversation(config, chatId);
    await sendReply(
      config,
      chatId,
      "🆕 Fresh conversation — I've cleared the earlier context. Your model and persona stay the same.",
    );
    return;
  }

  if (command === "status") {
    const day = todayUsage(config);
    const cap = config.dailyCostCapUsd;
    const lines = [
      "📊 <b>Status</b>",
      `Model: <code>${escapeHtml(agent.config.llmProvider)}/${escapeHtml(agent.config.llmModel)}</code> (reasoning: ${escapeHtml(agent.config.reasoningEffort)})`,
      `Today: ${day.runs} runs · ${formatTokenCount(day.tokens)} tok · $${day.costUSD.toFixed(4)}`,
      `Daily cap: ${cap > 0 ? `$${cap.toFixed(2)}` : "none"}`,
      `Uptime: ${formatUptime(Date.now() - BRIDGE_STARTED_AT)}`,
    ];
    await sendReply(config, chatId, lines.join("\n"));
    return;
  }

  if (command === "model") {
    const models = await listOllamaModels(config);
    if (models.length === 0) {
      await sendReply(config, chatId, "⚠️ No models available from Ollama right now.");
      return;
    }
    await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: "Pick a model:",
      reply_markup: { inline_keyboard: keyboardFrom(models, agent.config.llmModel, "m") },
    });
    return;
  }

  if (command === "persona") {
    const personas = listPersonas(config);
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
    void handleMessage(config, chatId, item.prompt).catch((error) =>
      console.error(`Suggestion follow-up failed for chat ${chatId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "x") {
    const run = activeRuns.get(indexRaw ?? "");
    if (run) {
      run.cancelled = true;
      run.child.kill();
    }
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: run ? "Cancelling…" : "Already finished.",
    });
    return;
  }

  if (kind === "f") {
    const prompt = FOLLOWUP_PROMPTS[indexRaw ?? ""];
    await callTelegram(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(prompt ? {} : { text: "Unknown action" }),
    });
    if (!prompt) return;
    // Drop the follow-up buttons so they can't be tapped twice.
    await callTelegram(config, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    void handleMessage(config, chatId, prompt).catch((error) =>
      console.error(`Follow-up failed for chat ${chatId}: ${String(error)}`),
    );
    return;
  }

  if (kind === "r") {
    const cancelled = cancelReminder(config, chatId, indexRaw ?? "");
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
  const agent = ensureChatAgent(config, chatId);
  let confirmation: string;

  if (kind === "m") {
    const models = await listOllamaModels(config);
    const model = Number.isInteger(index) ? models[index] : undefined;
    if (model === undefined) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "That list changed — run /model again.",
      });
      return;
    }
    const reasoning = (await modelSupportsThinking(config, model)) ? "medium" : "disable";
    agent.model = `ollama/${model}`;
    agent.config.llmModel = model;
    agent.config.llmProvider = "ollama";
    agent.config.reasoningEffort = reasoning;
    writeAgentFile(config, agent);
    confirmation = `✅ Model → ${model}\nReasoning: ${reasoning}`;
  } else if (kind === "p") {
    const personas = listPersonas(config);
    const persona = Number.isInteger(index) ? personas[index] : undefined;
    if (persona === undefined) {
      await callTelegram(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "That list changed — run /persona again.",
      });
      return;
    }
    agent.config.persona = persona;
    writeAgentFile(config, agent);
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
  readonly text?: string;
  readonly location?: { readonly latitude?: number; readonly longitude?: number };
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
        : handleMessage(config, chatId, text);
  } else if (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
  ) {
    work = handleLocation(config, chatId, latitude, longitude);
  }

  // Other message types (photo, sticker, …) aren't handled yet.
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

async function start(): Promise<void> {
  const config = loadConfig();
  startHealthServer(config);
  startReminderSweep(config);
  console.log(
    `Telegram → Jazz bridge started (mode="${config.mode}", per-chat agents, policy="${config.approvalPolicy}")`,
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

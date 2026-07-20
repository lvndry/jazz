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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TELEGRAM_API_BASE = "https://api.telegram.org";
// Telegram's hard limit is 4096; split lower so HTML tags/entities added by
// markdown rendering can't push a chunk over the limit.
const TELEGRAM_SPLIT_LENGTH = 3500;
const GETUPDATES_TIMEOUT_SECONDS = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;
const ALLOWED_UPDATES = ["message", "callback_query"];

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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  let text = markdown.replace(
    /```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      codeBlocks.push(
        `<pre><code${languageClass}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
      );
      return ` CB${codeBlocks.length - 1} `;
    },
  );

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return ` IC${inlineCodes.length - 1} `;
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

  text = text.replace(/ IC(\d+) /g, (_match, index: string) => inlineCodes[Number(index)] ?? "");
  text = text.replace(/ CB(\d+) /g, (_match, index: string) => codeBlocks[Number(index)] ?? "");
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

async function sendReply(config: BridgeConfig, chatId: number, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    const rendered = await callTelegram(config, "sendMessage", {
      chat_id: chatId,
      text: markdownToTelegramHtml(chunk),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    if (!isOkResponse(rendered)) {
      // Rendering was rejected (malformed entities, too long, …) — send raw text.
      await callTelegram(config, "sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}

// --- Jazz invocation ------------------------------------------------------

async function runJazz(
  config: BridgeConfig,
  chatId: number,
  prompt: string,
): Promise<JazzEnvelope> {
  const child = Bun.spawn(
    [
      config.jazzBinary,
      "run",
      "--no-tui",
      "--json",
      "--agent",
      agentIdForChat(chatId),
      "--approval-policy",
      config.approvalPolicy,
      "--conversation",
      String(chatId),
      "--timeout",
      String(config.runTimeoutMs),
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );

  const timeout = setTimeout(() => child.kill(), config.runTimeoutMs + 15_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);

  const lastJsonLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);

  if (lastJsonLine === undefined) {
    console.error(`Jazz produced no JSON envelope (exit ${exitCode}). stderr:\n${stderr}`);
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
  await callTelegram(config, "sendChatAction", { chat_id: chatId, action: "typing" });

  const envelope = await runJazz(config, chatId, text);
  if (envelope.ok) {
    await sendReply(config, chatId, envelope.answer);
  } else {
    await sendReply(config, chatId, `⚠️ ${envelope.error}`);
  }
}

// --- Commands & inline keyboards ------------------------------------------

const HELP_TEXT = [
  "I'm your Jazz assistant. Just send a message and I'll answer.",
  "",
  "Commands:",
  "/model — pick which Ollama model I use (just for you)",
  "/persona — pick my persona / style",
  "/help — show this",
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

async function handleCommand(config: BridgeConfig, chatId: number, command: string): Promise<void> {
  const agent = ensureChatAgent(config, chatId);

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

  const [kind, indexRaw] = data.split(":");
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
}

interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: CallbackQuery;
}

function parseCommand(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?/.exec(text.trim());
  return match?.[1]?.toLowerCase();
}

function dispatchMessage(config: BridgeConfig, message: TelegramMessage | undefined): void {
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (typeof chatId !== "number" || typeof text !== "string" || text.length === 0) {
    return;
  }
  if (!config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring message from non-allowed chat ${chatId}`);
    return;
  }

  const command = parseCommand(text);
  const work =
    command !== undefined
      ? handleCommand(config, chatId, command)
      : handleMessage(config, chatId, text);
  work.catch((error) => {
    console.error(`Handling failed for chat ${chatId}: ${String(error)}`);
    void sendReply(config, chatId, "⚠️ Something went wrong handling your message.");
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

      for (const update of response?.result ?? []) {
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

/**
 * Telegram → Jazz bridge.
 *
 * Every inbound message goes to the shared turn runner (`@jazz/bot-shared/turn`), which
 * owns the conversation from there: one run at a time per chat, the live progress bubble
 * with its ⏹ Cancel button, approvals with Approve all and Always allow, questions, the
 * command set and its pickers, reminders, incognito, and the answer. What is here is what
 * only Telegram has: the Bot API transport (long-poll or webhook), who is allowed in,
 * turning a tapped button back into a choice, media downloads, shared locations, and the
 * contextual suggestion buttons swapped in under an answer.
 *
 * Two transports, chosen by TELEGRAM_MODE:
 *   - "polling"  (default) — getUpdates long-poll; no public endpoint needed.
 *   - "webhook"            — Telegram POSTs to /telegram/webhook (needs a public URL).
 *
 * A small HTTP server always runs for container health checks and for serving the web
 * apps `create_composition` makes.
 *
 * Runs on Bun. All configuration is via environment variables (see .env.example).
 */

import { backoffDelay } from "@jazz/bot-shared/backoff";
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
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { answerRunFromChat, isRunAnswerCommand } from "@jazz/bot-shared/run-answer";
import { secretsMatch } from "@jazz/bot-shared/secret-compare";
import { ensureSeedAgent } from "@jazz/bot-shared/seed-agent";
import { installShutdown } from "@jazz/bot-shared/shutdown";
import { code, line, plainLine, text } from "@jazz/bot-shared/surface";
import { setTzForChat, isValidTimeZone } from "@jazz/bot-shared/timezone-store";
import {
  type ChoiceOutcome,
  createTurnRunner,
  type InboundMessage,
  type TurnConfig,
  type TurnRunner,
} from "@jazz/bot-shared/turn";
import { parseCommand } from "@jazz/bot-shared/turn-commands";
import tzlookup from "tz-lookup";
import { agentIdForChat, chatIdFromAgentId, syncAgentDisplayName } from "./agents";
import {
  buildMediaPrompt,
  downloadTelegramFile,
  type ExtractedMedia,
  extractMedia,
  type TelegramMediaFields,
} from "./media";
import { withReplyContext } from "./quotes";
import { createTelegramSurface, DEFAULT_TELEGRAM_API_BASE, type TelegramSurface } from "./surface";

const STORE_FILES = {
  timezone: "tg-tz.json",
  sessions: "tg-sessions.json",
  mode: "tg-mode.json",
} as const;
const INCOGNITO_FILE = "tg-incognito.json";
const COMPOSITIONS_FILE = "tg-compositions.json";
const SUGGEST_AGENT_ID = "tg_suggest";

const GETUPDATES_TIMEOUT_SECONDS = 30;
/** Reconnect backoff after failed polls: jittered, from one second up to a minute. */
const POLL_BACKOFF = { baseMs: 1_000, maxMs: 60_000 } as const;
/**
 * A poll returns at least every `GETUPDATES_TIMEOUT_SECONDS`, so a healthy loop beats that
 * often; three missed polls is a loop that is not getting through.
 */
const POLL_STALE_AFTER_MS = GETUPDATES_TIMEOUT_SECONDS * 3 * 1000;
/** Webhook mode has no poll, so it asks Telegram about the webhook this often instead. */
const WEBHOOK_PROBE_MS = 60_000;
const ALLOWED_UPDATES = ["message", "callback_query"];

/**
 * The reasoning log goes out as collapsed, tap-to-expand quotes, so Telegram can carry more
 * of it than a surface where each part is a notification. Escaping adds a few percent to
 * model prose, so this stays under the 3500 the message splitter uses.
 */
const REASONING_PART_CHARS = 2_800;
const REASONING_MAX_PARTS = 4;

/** How long a shared location's reverse geocode may take before the prompt goes without it. */
const GEOCODE_TIMEOUT_MS = 8_000;

type TransportMode = "polling" | "webhook";

export interface BridgeConfig {
  readonly botToken: string;
  /** The Bot API origin: Telegram's, or a self-hosted Bot API server. */
  readonly apiBase: string;
  readonly mode: TransportMode;
  readonly webhookSecret: string;
  readonly webhookUrl: string | undefined;
  readonly allowedChatIds: ReadonlySet<number>;
  /**
   * Telegram user ids allowed to widen a chat's authority: `/mode yolo` and "Always allow".
   * Being in an allowed chat is not enough, since in a group that is everyone in it.
   */
  readonly operatorIds: ReadonlySet<string>;
  readonly baseAgentId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
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
  /** Generate contextual follow-up buttons per answer (a second short LLM call). */
  readonly dynamicCta: boolean;
  /** Attach the run's full reasoning under the answer as collapsed quotes. */
  readonly showReasoning: boolean;
  /**
   * Public HTTPS origin this bridge's own HTTP server is reachable at, used to build Web
   * App button URLs for `create_composition`'s interactive mode (e.g. a Tailscale Funnel
   * origin). Falls back to TELEGRAM_WEBHOOK_URL's origin in webhook mode. Undefined
   * disables interactive web apps (static/image mode still works).
   */
  readonly webAppBaseUrl: string | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function parseIdList(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isFinite(entry)),
  );
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
}

function loadConfig(): BridgeConfig {
  const allowedChatIds = parseIdList(process.env["TELEGRAM_ALLOWED_CHAT_IDS"]?.trim() ?? "");
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
    apiBase:
      process.env["TELEGRAM_API_BASE_URL"]?.trim().replace(/\/$/, "") || DEFAULT_TELEGRAM_API_BASE,
    mode,
    webhookSecret: process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim() || "",
    webhookUrl,
    allowedChatIds,
    operatorIds: new Set(
      [...parseIdList(process.env["TELEGRAM_OPERATOR_IDS"]?.trim() ?? "")].map(String),
    ),
    baseAgentId: process.env["JAZZ_TELEGRAM_AGENT"]?.trim() || "telegram",
    provider: process.env["JAZZ_TELEGRAM_PROVIDER"]?.trim() || "openai",
    model: process.env["JAZZ_TELEGRAM_MODEL"]?.trim() || "gpt-5.4",
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
    geocodeUrl: process.env["NOMINATIM_BASE_URL"]?.trim() ?? "https://nominatim.openstreetmap.org",
    dynamicCta: envFlag("JAZZ_TELEGRAM_DYNAMIC_CTA", true),
    showReasoning: envFlag("JAZZ_TELEGRAM_SHOW_REASONING", true),
    webAppBaseUrl,
  };
}

/** Everything the transport handlers need, built once at start. */
export interface Bridge {
  readonly config: BridgeConfig;
  readonly health: HealthState;
  readonly surface: TelegramSurface;
  readonly runner: TurnRunner;
  readonly compositions: CompositionLinks;
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
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { display_name?: string };
    return typeof data.display_name === "string" ? data.display_name : null;
  } catch (error) {
    console.error(`Reverse geocode failed: ${String(error)}`);
    return null;
  }
}

/** Best-effort: set the chat's timezone from shared coordinates, and tell them. */
async function maybeSetTzFromLocation(
  bridge: Bridge,
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
  const previous = setTzForChat(bridge.config.jazzHome, STORE_FILES.timezone, chatId, detected);
  if (previous === detected) return;
  const hadZone = typeof previous === "string" && isValidTimeZone(previous);
  await bridge.runner.send(String(chatId), [
    line(
      text(`🌍 ${hadZone ? "Updated" : "Set"} your timezone to `),
      code(detected),
      text(" from this location — reminders will use it. Change it anytime with "),
      code("/tz"),
      text("."),
    ),
  ]);
}

async function handleLocation(
  bridge: Bridge,
  chatId: number,
  senderId: string,
  latitude: number,
  longitude: number,
): Promise<void> {
  await maybeSetTzFromLocation(bridge, chatId, latitude, longitude);
  const address = await reverseGeocode(bridge.config, latitude, longitude);
  const mapLink = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
  const prompt =
    "[The user shared their current location.]\n" +
    `Coordinates: latitude ${latitude}, longitude ${longitude}\n` +
    (address ? `Approximate address (reverse-geocoded): ${address}\n` : "") +
    `Map: ${mapLink}\n\n` +
    "Tell me briefly where this is (neighborhood and a nearby landmark), then ask what I need — " +
    "directions to a place, the nearest something, etc. Use web search for anything nearby or for routing.";
  await bridge.runner.handle({ chatId: String(chatId), senderId, text: prompt });
}

// --- Commands menu --------------------------------------------------------

/**
 * Registered with Telegram via `setMyCommands` so these show up in the client's "/"
 * autocomplete menu. `command` must be lowercase letters/digits/underscores only.
 */
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "model", description: "Pick a model, or /model provider/model for any provider" },
  { command: "persona", description: "Pick my persona / style" },
  { command: "mode", description: "Safe (ask before risky tools) or yolo (never ask; operators)" },
  { command: "new", description: "Start a fresh conversation (clears earlier context)" },
  { command: "incognito", description: "Start a private conversation (nothing saved) until /new" },
  { command: "remind", description: "Set a reminder, e.g. /remind 30m take pizza out" },
  { command: "reminders", description: "List and cancel your reminders" },
  { command: "tz", description: "Set your timezone, e.g. /tz Europe/Paris" },
  { command: "status", description: "Model, today's usage, uptime" },
  { command: "help", description: "Show available commands" },
];

// --- Buttons --------------------------------------------------------------

export interface CallbackQuery {
  readonly id?: string;
  readonly data?: string;
  readonly message?: { readonly message_id?: number; readonly chat?: { readonly id?: number } };
  readonly from?: { readonly id?: number };
}

const suggestions = createSuggestionStore();

/** The toast a tap gets, when it did not simply work. */
function toastFor(outcome: ChoiceOutcome, senderId: string): string | undefined {
  switch (outcome) {
    case "answered":
      return undefined;
    case "expired":
      return "This already expired or the run finished.";
    case "not-requester":
      return "Only the person who asked can answer this.";
    case "not-operator":
      return `Only this bot's operator can do that. Your id is ${senderId}; the operator adds it to TELEGRAM_OPERATOR_IDS.`;
  }
}

/** A tap on a contextual suggestion: a new turn, threaded under the answer it came from. */
async function handleSuggestionTap(
  bridge: Bridge,
  chatId: string,
  senderId: string,
  messageRef: string,
  token: string,
  choiceId: string,
): Promise<ChoiceOutcome> {
  const item = suggestions.get(token)?.[Number.parseInt(choiceId, 10)];
  if (item === undefined) return "expired";
  await bridge.surface.setChoices(chatId, messageRef, []);
  await bridge.surface.send(chatId, { body: [plainLine(item.label)], replyTo: messageRef });
  void bridge.runner
    .handle({ chatId, senderId, text: item.prompt, replyTo: messageRef })
    .catch((error: unknown) => console.error(`Suggestion follow-up failed: ${String(error)}`));
  return "answered";
}

export async function handleCallback(bridge: Bridge, callback: CallbackQuery): Promise<void> {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const tapperId = callback.from?.id;
  const data = callback.data;
  if (
    typeof chatId !== "number" ||
    typeof messageId !== "number" ||
    typeof tapperId !== "number" ||
    typeof data !== "string"
  ) {
    return;
  }
  if (!bridge.config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring callback from non-allowed chat ${chatId}`);
    return;
  }

  const senderId = String(tapperId);
  const messageRef = String(messageId);
  const choice = bridge.surface.readChoice(data);
  let outcome: ChoiceOutcome;
  if (choice === undefined) {
    // A keyboard drawn before a restart, or by an earlier version of the bridge.
    outcome = "expired";
  } else if (choice.promptId.startsWith(SUGGESTION_PROMPT_PREFIX)) {
    outcome = await handleSuggestionTap(
      bridge,
      String(chatId),
      senderId,
      messageRef,
      choice.promptId.slice(SUGGESTION_PROMPT_PREFIX.length),
      choice.choiceId,
    );
  } else {
    outcome = await bridge.runner.deliverChoice({
      chatId: String(chatId),
      promptId: choice.promptId,
      choiceId: choice.choiceId,
      senderId,
      messageRef,
    });
  }

  const toast = toastFor(outcome, senderId);
  await bridge.surface.call("answerCallbackQuery", {
    callback_query_id: callback.id,
    ...(toast === undefined ? {} : { text: toast, show_alert: outcome !== "expired" }),
  });
}

// --- Dispatch -------------------------------------------------------------

export interface TelegramMessage extends TelegramMediaFields {
  readonly chat?: { readonly id?: number };
  readonly from?: {
    readonly id?: number;
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
}

/**
 * Download a media message and hand it to jazz as a path in the prompt.
 *
 * A download failure is reported to the chat rather than swallowed: the user watched their
 * voice note upload and will otherwise be left waiting on a reply that never comes.
 */
async function handleMedia(
  bridge: Bridge,
  chatId: number,
  senderId: string,
  message: TelegramMessage,
  media: ExtractedMedia,
): Promise<void> {
  const sandbox = ensureChatSandbox(bridge.config.jazzHome, agentIdForChat(chatId));
  const outcome = await downloadTelegramFile(
    bridge.config.apiBase,
    bridge.config.botToken,
    sandbox.home,
    media.file,
    chatId,
    Date.now(),
    sandboxOwnership(sandbox),
  );
  if (!outcome.ok) {
    await bridge.runner.send(String(chatId), [
      plainLine(`⚠️ I couldn't fetch that file — ${outcome.reason}.`),
    ]);
    return;
  }
  await bridge.runner.handle({
    chatId: String(chatId),
    senderId,
    text: withReplyContext(
      message,
      buildMediaPrompt(outcome.path, message.caption, media.fallbackInstruction),
    ),
  });
}

/**
 * What one Telegram message asks the runner to do, or undefined for a message type this
 * bridge does not handle (contacts, polls, animated stickers). Pure, so the routing can be
 * tested without the Bot API.
 */
export function inboundFrom(message: TelegramMessage): InboundMessage | undefined {
  const chatId = message.chat?.id;
  const text = message.text?.trim();
  if (typeof chatId !== "number" || text === undefined || text.length === 0) return undefined;
  // In a private chat the sender is the chat; elsewhere Telegram always names them.
  const senderId = String(message.from?.id ?? chatId);
  return {
    chatId: String(chatId),
    senderId,
    // A command is read as typed; a quote only gives prose its context.
    text: text.startsWith("/") ? text : withReplyContext(message, text),
  };
}

export function dispatchMessage(bridge: Bridge, message: TelegramMessage | undefined): void {
  const chatId = message?.chat?.id;
  if (typeof chatId !== "number") return;
  if (!bridge.config.allowedChatIds.has(chatId)) {
    console.warn(`Ignoring message from non-allowed chat ${chatId}`);
    return;
  }
  const senderId = String(message?.from?.id ?? chatId);
  const latitude = message?.location?.latitude;
  const longitude = message?.location?.longitude;

  let work: Promise<void> | undefined;
  const inbound = message === undefined ? undefined : inboundFrom(message);
  if (inbound !== undefined) {
    const parsed = parseCommand(inbound.text);
    work =
      parsed !== undefined && isRunAnswerCommand(parsed.command)
        ? answerRunFromChat({
            command: parsed.command,
            args: parsed.args,
            senderId:
              message?.from?.is_bot === true || message?.from?.id === undefined
                ? undefined
                : String(message.from.id),
            operatorIds: bridge.config.operatorIds,
            operatorSettingName: "TELEGRAM_OPERATOR_IDS",
            jazzBinary: bridge.config.jazzBinary,
            onAccepted: (runId) =>
              bridge.runner.send(String(chatId), [plainLine(`⏳ Answering run ${runId}…`)]),
          }).then((reply) => bridge.runner.send(String(chatId), [plainLine(reply)]))
        : bridge.runner.handle(inbound);
  } else if (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
  ) {
    work = handleLocation(bridge, chatId, senderId, latitude, longitude);
  } else {
    const media = extractMedia(message ?? {});
    if (media !== undefined) {
      work = handleMedia(bridge, chatId, senderId, message ?? {}, media);
    }
  }
  if (work === undefined) return;

  work.catch((error) => {
    console.error(`Handling failed for chat ${chatId}: ${String(error)}`);
    // Guard the notification itself so a failed reply can't become an unhandled rejection.
    void bridge.runner
      .send(String(chatId), [plainLine("⚠️ Something went wrong handling your message.")])
      .catch((replyError) =>
        console.error(`Failed to notify chat ${chatId}: ${String(replyError)}`),
      );
  });
}

interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: CallbackQuery;
}

function dispatchUpdate(bridge: Bridge, update: TelegramUpdate): void {
  if (update.message !== undefined) {
    dispatchMessage(bridge, update.message);
  }
  if (update.callback_query !== undefined) {
    handleCallback(bridge, update.callback_query).catch((error) => {
      console.error(`Callback handling failed: ${String(error)}`);
    });
  }
}

// --- Transports -----------------------------------------------------------

function startHealthServer(bridge: Bridge): void {
  const { config } = bridge;
  Bun.serve({
    port: config.port,
    async fetch(request) {
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

      if (
        config.mode === "webhook" &&
        request.method === "POST" &&
        url.pathname === "/telegram/webhook"
      ) {
        const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
        if (!secretsMatch(config.webhookSecret, providedSecret)) {
          return new Response("forbidden", { status: 403 });
        }
        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return new Response("bad request", { status: 400 });
        }
        bridge.health.beat();
        dispatchUpdate(bridge, update);
        return new Response("ok", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Health server listening on :${config.port}`);
}

async function registerWebhook(bridge: Bridge): Promise<void> {
  const { config } = bridge;
  if (config.webhookUrl === undefined || config.webhookSecret.length === 0) {
    throw new Error("webhook mode requires TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET");
  }
  // Pending updates are kept: a message sent while the bridge restarted is still answered.
  const registered = (await bridge.surface.call("setWebhook", {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
  })) as { ok?: boolean } | undefined;
  if (registered?.ok === true) bridge.health.beat();
  console.log(`Registered Telegram webhook → ${config.webhookUrl}`);
  const probe = setInterval(() => {
    void bridge.surface.call("getWebhookInfo", {}).then((info) => {
      if ((info as { ok?: boolean } | undefined)?.ok === true) bridge.health.beat();
    });
  }, WEBHOOK_PROBE_MS);
  probe.unref?.();
}

/** Set once a shutdown starts, so the poll loop stops asking for more. */
let polling = true;

async function pollLoop(bridge: Bridge): Promise<void> {
  // Polling and webhooks are mutually exclusive on Telegram's side. Pending updates are
  // kept, so a message sent while the bridge restarted is still answered.
  await bridge.surface.call("deleteWebhook", {});
  console.log("Polling Telegram for updates…");

  let offset = 0;
  let failures = 0;
  while (polling) {
    try {
      const response = (await bridge.surface.call("getUpdates", {
        offset,
        timeout: GETUPDATES_TIMEOUT_SECONDS,
        allowed_updates: ALLOWED_UPDATES,
      })) as { ok?: boolean; result?: TelegramUpdate[] } | undefined;

      if (response?.ok !== true) {
        // Fall into the catch so we back off instead of tight-looping on a
        // persistent failure (bad token, 409 conflict, rate limit, …).
        throw new Error("getUpdates returned a non-ok response");
      }
      failures = 0;
      bridge.health.beat();
      if (!polling) break;

      for (const update of response.result ?? []) {
        if (typeof update.update_id === "number") {
          offset = update.update_id + 1;
        }
        dispatchUpdate(bridge, update);
      }
    } catch (error) {
      const delayMs = backoffDelay(failures, POLL_BACKOFF);
      failures += 1;
      console.error(`Poll error: ${String(error)}; retrying in ${delayMs}ms`);
      await Bun.sleep(delayMs);
    }
  }
}

/** The bot's own display name, used as the agent name the persona speaks as. */
async function fetchBotName(surface: TelegramSurface): Promise<string | undefined> {
  const body = (await surface.call("getMe", {})) as
    { result?: { first_name?: string; username?: string } } | undefined;
  return body?.result?.first_name ?? body?.result?.username;
}

/**
 * Wire the surface, the runner and the web-app store together for one configuration.
 *
 * `startRun` is the runner's test seam: a substitute for spawning `jazz run`.
 */
export function createBridge(
  config: BridgeConfig,
  surface: TelegramSurface,
  startRun?: TurnConfig["startRun"],
): Bridge {
  const compositions = createCompositionLinks(config.jazzHome, COMPOSITIONS_FILE);
  const runner = createTurnRunner({
    surface,
    ...(startRun === undefined ? {} : { startRun }),
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
    spendOrigin: "telegram",
    incognitoFile: INCOGNITO_FILE,
    agentIdFor: (chatId) => agentIdForChat(Number.parseInt(chatId, 10)),
    operators: config.operatorIds,
    operatorSettingName: "TELEGRAM_OPERATOR_IDS",
    ...(config.webAppBaseUrl === undefined
      ? {}
      : { compositionServer: { publicBaseUrl: config.webAppBaseUrl, links: compositions } }),
    publicUrlSettingName: "TELEGRAM_WEBAPP_BASE_URL",
    extraHelp: [
      "/approve <runId>, /deny <runId> [why]: answer a parked run a notification told you about (operator only)",
      "",
      "📍 Share your location (📎 → Location) and I'll tell you where you are, find nearby places, and set your timezone.",
    ],
    extraTzHelp: "…or share your location (📎 → Location) and I'll set it for you.",
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
              sandbox: ensureChatSandbox(
                config.jazzHome,
                agentIdForChat(Number.parseInt(turn.chatId, 10)),
              ),
              question: turn.question,
              answer: turn.answer,
            });
            console.log(`[cta] chat ${turn.chatId}: ${items.length} contextual suggestion(s)`);
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
    health: createHealthState(POLL_STALE_AFTER_MS),
  };
}

export async function startBridge(): Promise<void> {
  const config = loadConfig();
  // Everything this process and its agents write stays off-limits to anyone outside the
  // operator group — the data directory is shared with whoever else is on the host.
  process.umask(SANDBOX_UMASK);

  if (
    ensureSeedAgent(config.jazzHome, {
      id: config.baseAgentId,
      name: "Jazz",
      description: "Everyday assistant reachable from Telegram.",
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
  // Drop the cached suggestion agent so it re-seeds from the current template.
  removeSuggestAgents(config.jazzHome, SUGGEST_AGENT_ID);

  const bridge = createBridge(
    config,
    createTelegramSurface({ botToken: config.botToken, apiBase: config.apiBase }),
  );
  startHealthServer(bridge);
  startReminderSweep({
    dataDir: config.jazzHome,
    decodeScope: (agentId) => {
      const reminderChatId = chatIdFromAgentId(agentId);
      return reminderChatId === undefined ? undefined : String(reminderChatId);
    },
    send: (reminderChatId, body) => bridge.runner.send(reminderChatId, body),
  });
  // Populates Telegram's "/" autocomplete menu. Cheap and idempotent, so it's re-sent on
  // every start rather than only when BOT_COMMANDS changes.
  await bridge.surface.call("setMyCommands", { commands: BOT_COMMANDS });
  const botName = await fetchBotName(bridge.surface);
  if (botName !== undefined) {
    syncAgentDisplayName(config.jazzHome, config.baseAgentId, botName);
  }
  console.log(
    `Telegram → Jazz bridge started as ${botName ?? "an unnamed bot"} (mode="${config.mode}", per-chat agents, policy="${config.approvalPolicy}")`,
  );

  installShutdown({
    runner: bridge.runner,
    stopIntake: () => {
      polling = false;
    },
  });

  if (config.mode === "webhook") {
    await registerWebhook(bridge);
  } else {
    await pollLoop(bridge);
  }
}

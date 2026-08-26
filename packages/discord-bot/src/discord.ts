/**
 * Discord REST + Gateway, no SDK.
 *
 * REST is a thin fetch wrapper with 429 retries. The Gateway is a reconnecting
 * WebSocket that heartbeats, identifies, and dispatches MESSAGE_CREATE /
 * INTERACTION_CREATE / GUILD_CREATE. Compression is off so payloads stay JSON.
 */

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_USER_AGENT = "DiscordBot (https://github.com/lvndry/jazz, 1.0)";

/** GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export const CHANNEL_TYPE_DM = 1;
export const CHANNEL_TYPE_GROUP_DM = 3;
export const CHANNEL_TYPE_PUBLIC_THREAD = 11;
export const CHANNEL_TYPE_PRIVATE_THREAD = 12;
export const CHANNEL_TYPE_NEWS_THREAD = 10;

export const MESSAGE_TYPE_DEFAULT = 0;
export const MESSAGE_TYPE_REPLY = 19;

export const INTERACTION_PING = 1;
export const INTERACTION_APPLICATION_COMMAND = 2;
export const INTERACTION_MESSAGE_COMPONENT = 3;

export const CALLBACK_CHANNEL_MESSAGE = 4;
export const CALLBACK_DEFERRED_CHANNEL_MESSAGE = 5;
export const CALLBACK_DEFERRED_UPDATE = 6;
export const CALLBACK_UPDATE_MESSAGE = 7;

export const COMPONENT_ACTION_ROW = 1;
export const COMPONENT_BUTTON = 2;
export const COMPONENT_STRING_SELECT = 3;
export const BUTTON_SECONDARY = 2;
export const BUTTON_SUCCESS = 3;
export const BUTTON_DANGER = 4;

export const FLAG_EPHEMERAL = 64;

const NO_MENTIONS = { parse: [] as const };

export interface DiscordUser {
  readonly id: string;
  readonly bot?: boolean;
  readonly username?: string;
}

export interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly content: string;
  readonly type?: number;
  readonly author: DiscordUser;
  readonly mentions?: readonly DiscordUser[];
  readonly referenced_message?: { readonly author?: DiscordUser };
  readonly message_reference?: { readonly message_id?: string };
}

export interface DiscordInteractionOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
}

export interface DiscordInteraction {
  readonly id: string;
  readonly token: string;
  readonly type: number;
  readonly application_id: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly user?: DiscordUser;
  readonly member?: { readonly user?: DiscordUser };
  readonly message?: { readonly id: string; readonly channel_id?: string };
  readonly data?: {
    readonly name?: string;
    readonly custom_id?: string;
    readonly values?: readonly string[];
    readonly options?: readonly DiscordInteractionOption[];
  };
}

export interface DiscordChannel {
  readonly id: string;
  readonly type: number;
  readonly parent_id?: string | null;
  readonly guild_id?: string;
}

export interface GatewayHandlers {
  onReady(info: { userId: string; applicationId: string; username: string }): void;
  onMessage(message: DiscordMessage): void;
  onInteraction(interaction: DiscordInteraction): void;
  onGuildCreate(guildId: string): void;
}

interface GatewayPayload {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const REST_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function discordRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REST_MAX_RETRIES; attempt++) {
    const headers: Record<string, string> = {
      authorization: `Bot ${token}`,
      "user-agent": DISCORD_USER_AGENT,
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${DISCORD_API_BASE}${path}`, init);
    } catch (error) {
      lastError = error;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (response.status === 429) {
      const payload = (await response.json().catch(() => undefined)) as
        { retry_after?: number } | undefined;
      const retryAfter = payload?.retry_after ?? 1;
      await sleep(Math.ceil(retryAfter * 1000) + 50);
      continue;
    }

    if (response.status === 204) return undefined;

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      console.error(
        `Discord ${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`,
      );
      return payload;
    }
    return payload;
  }
  console.error(`Discord ${method} ${path} failed after retries: ${String(lastError)}`);
  return undefined;
}

export async function sendMessage(
  token: string,
  channelId: string,
  content: string,
  extras: Record<string, unknown> = {},
): Promise<{ id: string } | undefined> {
  const payload = (await discordRequest(token, "POST", `/channels/${channelId}/messages`, {
    content,
    allowed_mentions: NO_MENTIONS,
    ...extras,
  })) as { id?: string } | undefined;
  return typeof payload?.id === "string" ? { id: payload.id } : undefined;
}

export async function patchMessage(
  token: string,
  channelId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await discordRequest(token, "PATCH", `/channels/${channelId}/messages/${messageId}`, {
    allowed_mentions: NO_MENTIONS,
    ...body,
  });
}

export async function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  content: string,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await patchMessage(token, channelId, messageId, { content, ...extras });
}

export async function triggerTyping(token: string, channelId: string): Promise<void> {
  await discordRequest(token, "POST", `/channels/${channelId}/typing`);
}

export async function createThreadFromMessage(
  token: string,
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordChannel | undefined> {
  const payload = (await discordRequest(
    token,
    "POST",
    `/channels/${channelId}/messages/${messageId}/threads`,
    { name, auto_archive_duration: 1440 },
  )) as DiscordChannel | undefined;
  return typeof payload?.id === "string" ? payload : undefined;
}

export async function getChannel(
  token: string,
  channelId: string,
): Promise<DiscordChannel | undefined> {
  const payload = (await discordRequest(token, "GET", `/channels/${channelId}`)) as
    DiscordChannel | undefined;
  return typeof payload?.id === "string" ? payload : undefined;
}

export async function getOriginalInteraction(
  applicationId: string,
  interactionToken: string,
): Promise<{ id: string; channel_id?: string } | undefined> {
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    { headers: { "user-agent": DISCORD_USER_AGENT } },
  );
  const payload = (await response.json().catch(() => undefined)) as
    { id?: string; channel_id?: string } | undefined;
  if (typeof payload?.id !== "string") return undefined;
  return {
    id: payload.id,
    ...(payload.channel_id !== undefined ? { channel_id: payload.channel_id } : {}),
  };
}

export async function sendAttachment(
  token: string,
  channelId: string,
  filePath: string,
  filename: string,
  content?: string,
): Promise<void> {
  const form = new FormData();
  form.append("files[0]", Bun.file(filePath), filename);
  form.append(
    "payload_json",
    JSON.stringify({
      content: content ?? "",
      allowed_mentions: NO_MENTIONS,
    }),
  );
  await discordRequest(token, "POST", `/channels/${channelId}/messages`, form);
}

export async function interactionCallback(
  interactionId: string,
  interactionToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  // Interaction callbacks are unauthenticated (the token *is* the auth).
  const response = await fetch(
    `${DISCORD_API_BASE}/interactions/${interactionId}/${interactionToken}/callback`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": DISCORD_USER_AGENT },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok && response.status !== 204) {
    const payload = await response.text().catch(() => "");
    console.error(`Discord interaction callback failed: ${response.status} ${payload}`);
  }
}

export async function editOriginalInteraction(
  applicationId: string,
  interactionToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", "user-agent": DISCORD_USER_AGENT },
      body: JSON.stringify({ allowed_mentions: NO_MENTIONS, ...body }),
    },
  );
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    console.error(`Discord interaction edit failed: ${response.status} ${payload}`);
  }
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly {
    readonly name: string;
    readonly description: string;
    readonly type: number;
    readonly required?: boolean;
  }[];
}

export async function bulkOverwriteGlobalCommands(
  token: string,
  applicationId: string,
  commands: readonly SlashCommand[],
): Promise<void> {
  await discordRequest(token, "PUT", `/applications/${applicationId}/commands`, commands);
}

export async function bulkOverwriteGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  commands: readonly SlashCommand[],
): Promise<void> {
  await discordRequest(
    token,
    "PUT",
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    commands,
  );
}

export function interactionUserId(interaction: DiscordInteraction): string | undefined {
  return interaction.user?.id ?? interaction.member?.user?.id;
}

export function isThreadChannelType(type: number): boolean {
  return (
    type === CHANNEL_TYPE_PUBLIC_THREAD ||
    type === CHANNEL_TYPE_PRIVATE_THREAD ||
    type === CHANNEL_TYPE_NEWS_THREAD
  );
}

export function isRespondableMessage(message: DiscordMessage): boolean {
  const type = message.type ?? MESSAGE_TYPE_DEFAULT;
  return type === MESSAGE_TYPE_DEFAULT || type === MESSAGE_TYPE_REPLY;
}

export function actionRow(components: unknown[]): Record<string, unknown> {
  return { type: COMPONENT_ACTION_ROW, components };
}

export function button(customId: string, label: string, style: number): Record<string, unknown> {
  return { type: COMPONENT_BUTTON, custom_id: customId, label: label.slice(0, 80), style };
}

export function stringSelect(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string; default?: boolean }[],
): Record<string, unknown> {
  return {
    type: COMPONENT_STRING_SELECT,
    custom_id: customId,
    placeholder,
    options: options.slice(0, 25).map((option) => ({
      label: option.label.slice(0, 100),
      value: option.value.slice(0, 100),
      ...(option.default === true ? { default: true } : {}),
    })),
  };
}

interface GatewayBotInfo {
  readonly url?: string;
  readonly session_start_limit?: { readonly remaining?: number; readonly reset_after?: number };
}

/**
 * Connect to the Discord Gateway and keep the connection alive. Returns a
 * stop function. Reconnects on close / invalid session / reconnect opcode.
 */
export function connectGateway(token: string, handlers: GatewayHandlers): { stop: () => void } {
  let stopped = false;
  let socket: WebSocket | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastSequence: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let heartbeatAcked = true;
  let identifyAfterInvalidSession = false;

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (heartbeatTimeout !== undefined) clearTimeout(heartbeatTimeout);
    heartbeatTimer = undefined;
    heartbeatTimeout = undefined;
  }

  function send(payload: Record<string, unknown>): void {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  function sendHeartbeat(): void {
    send({ op: OP_HEARTBEAT, d: lastSequence });
  }

  function onHeartbeatInterval(): void {
    if (!heartbeatAcked) {
      console.warn("Discord gateway heartbeat not acknowledged — reconnecting");
      socket?.close(4000, "zombied");
      return;
    }
    heartbeatAcked = false;
    sendHeartbeat();
  }

  function startHeartbeat(intervalMs: number): void {
    clearHeartbeat();
    heartbeatAcked = true;
    const jitter = Math.random() * intervalMs;
    heartbeatTimeout = setTimeout(() => {
      onHeartbeatInterval();
      heartbeatTimer = setInterval(onHeartbeatInterval, intervalMs);
    }, jitter);
  }

  function identify(): void {
    send({
      op: OP_IDENTIFY,
      d: {
        token,
        intents: DISCORD_INTENTS,
        properties: { os: process.platform, browser: "jazz", device: "jazz" },
      },
    });
  }

  function resume(): void {
    if (sessionId === undefined) {
      identify();
      return;
    }
    send({
      op: OP_RESUME,
      d: { token, session_id: sessionId, seq: lastSequence },
    });
  }

  function handleDispatch(eventName: string, data: unknown): void {
    if (eventName === "READY") {
      const ready = data as {
        session_id?: string;
        resume_gateway_url?: string;
        user?: { id?: string; username?: string };
        application?: { id?: string };
      };
      if (typeof ready.session_id === "string") sessionId = ready.session_id;
      if (typeof ready.resume_gateway_url === "string") resumeUrl = ready.resume_gateway_url;
      const userId = ready.user?.id;
      const applicationId = ready.application?.id ?? userId;
      if (typeof userId === "string" && typeof applicationId === "string") {
        handlers.onReady({
          userId,
          applicationId,
          username: ready.user?.username ?? "jazz",
        });
      }
      return;
    }
    if (eventName === "RESUMED") {
      console.log("Discord gateway session resumed");
      return;
    }
    if (eventName === "MESSAGE_CREATE") {
      handlers.onMessage(data as DiscordMessage);
      return;
    }
    if (eventName === "INTERACTION_CREATE") {
      handlers.onInteraction(data as DiscordInteraction);
      return;
    }
    if (eventName === "GUILD_CREATE") {
      const guild = data as { id?: string };
      if (typeof guild.id === "string") handlers.onGuildCreate(guild.id);
    }
  }

  function handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === "number") lastSequence = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval;
        if (typeof interval !== "number") return;
        startHeartbeat(interval);
        if (identifyAfterInvalidSession || sessionId === undefined) {
          identifyAfterInvalidSession = false;
          identify();
        } else {
          resume();
        }
        break;
      }
      case OP_HEARTBEAT_ACK:
        heartbeatAcked = true;
        break;
      case OP_HEARTBEAT:
        sendHeartbeat();
        break;
      case OP_RECONNECT:
        socket?.close(4000, "reconnect");
        break;
      case OP_INVALID_SESSION: {
        const resumable = payload.d === true;
        if (!resumable) {
          sessionId = undefined;
          lastSequence = null;
          identifyAfterInvalidSession = true;
        }
        socket?.close(4000, "invalid session");
        break;
      }
      case OP_DISPATCH:
        if (typeof payload.t === "string") handleDispatch(payload.t, payload.d);
        break;
      default:
        break;
    }
  }

  async function open(): Promise<void> {
    if (stopped) return;

    let url = resumeUrl;
    if (url === undefined || sessionId === undefined) {
      const info = (await discordRequest(token, "GET", "/gateway/bot")) as
        GatewayBotInfo | undefined;
      const remaining = info?.session_start_limit?.remaining;
      if (remaining === 0) {
        const wait = info?.session_start_limit?.reset_after ?? 5000;
        console.warn(`Discord session start limit exhausted — waiting ${wait}ms`);
        await sleep(wait);
      }
      url = typeof info?.url === "string" ? info.url : "wss://gateway.discord.gg";
    }

    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    socket = ws;

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : undefined;
      if (raw === undefined) return;
      try {
        handlePayload(JSON.parse(raw) as GatewayPayload);
      } catch (error) {
        console.error(`Failed to parse Discord gateway payload: ${String(error)}`);
      }
    });

    ws.addEventListener("close", (event) => {
      clearHeartbeat();
      if (stopped) return;
      const delay = event.code === 4004 ? 60_000 : 2_000;
      if (event.code === 4004) {
        console.error("Discord gateway rejected the token (4004). Check DISCORD_BOT_TOKEN.");
      } else {
        console.warn(`Discord gateway closed (${event.code} ${event.reason}) — reconnecting`);
      }
      setTimeout(() => {
        void open();
      }, delay);
    });

    ws.addEventListener("error", () => {
      // close handler reconnects
    });
  }

  void open();

  return {
    stop: () => {
      stopped = true;
      clearHeartbeat();
      socket?.close(1000, "stop");
    },
  };
}

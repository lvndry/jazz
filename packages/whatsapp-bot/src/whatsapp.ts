/**
 * @fileoverview The WhatsApp connection: pairing, reconnection, and the shape
 * of an inbound message.
 *
 * WhatsApp has no personal API. Baileys speaks the WhatsApp Web protocol, which
 * means this bridge is a linked device on someone's account — the same standing
 * as WhatsApp Web in a browser — and inherits that situation's rules: the
 * account can be unlinked from the phone at any time, a logout is permanent
 * until re-paired, and the protocol is reverse-engineered rather than blessed.
 *
 * Everything Baileys-shaped is confined here. The bridge above works in plain
 * strings and never sees a `proto.IWebMessageInfo`, so a breaking change in the
 * library is a change to this file.
 */

import { mkdirSync } from "node:fs";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { proto } from "@whiskeysockets/baileys";
import type { Jid } from "./access";

/** An inbound message, flattened out of Baileys' nested proto shape. */
export interface WhatsAppMessage {
  readonly id: string;
  readonly chatJid: Jid;
  readonly senderJid: Jid;
  readonly pushName: string | undefined;
  readonly text: string;
  readonly isFromMe: boolean;
  /** JIDs this message @-mentions. */
  readonly mentions: readonly string[];
  /**
   * Who wrote the message this one replies to, when it is a reply.
   *
   * Not resolved to "is this us" here: only the bridge knows the linked
   * account's own JID, and that is not known until the connection is open.
   */
  readonly quotedAuthor: string | undefined;
  /** Present for image/audio/video/document messages; download with `saveMedia`. */
  readonly media: WhatsAppMedia | undefined;
}

export interface WhatsAppMedia {
  readonly kind: "image" | "audio" | "video" | "document";
  readonly mimeType: string;
  readonly fileName: string | undefined;
  /**
   * The whole `IMessage` this media belongs to, not just the media node.
   *
   * WhatsApp attachments are stored encrypted on Meta's servers and fetched on
   * demand, and the decryption keys live alongside the media node — so the
   * downloader needs the message as it arrived, and keeping only the inner node
   * would leave nothing able to decrypt it.
   */
  readonly source: proto.IMessage;
}

/**
 * Baileys logs at a volume that buries everything else and expects a pino-shaped
 * logger. This is that shape, wired to nothing — the bridge's own log lines are
 * the ones worth reading.
 */
type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]["logger"]>;

const SILENT_LOGGER = {
  level: "silent",
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => SILENT_LOGGER,
} as unknown as BaileysLogger;

function textOf(message: Record<string, unknown>): string {
  const conversation = message["conversation"];
  if (typeof conversation === "string") return conversation;

  for (const key of ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage"]) {
    const node = message[key];
    if (node !== null && typeof node === "object") {
      const candidate = (node as Record<string, unknown>)[
        key === "extendedTextMessage" ? "text" : "caption"
      ];
      if (typeof candidate === "string") return candidate;
    }
  }
  return "";
}

function mediaOf(message: Record<string, unknown>): WhatsAppMedia | undefined {
  const whole = message as unknown as proto.IMessage;
  const kinds = [
    ["imageMessage", "image"],
    ["audioMessage", "audio"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
  ] as const;

  for (const [key, kind] of kinds) {
    const node = message[key];
    if (node === null || typeof node !== "object") continue;
    const fields = node as Record<string, unknown>;
    return {
      kind,
      mimeType: typeof fields["mimetype"] === "string" ? fields["mimetype"] : "",
      fileName: typeof fields["fileName"] === "string" ? fields["fileName"] : undefined,
      source: whole,
    };
  }
  return undefined;
}

/**
 * Flatten one Baileys message, or undefined when there is nothing to answer.
 *
 * Protocol traffic (receipts, key distribution, reactions, poll updates) comes
 * through the same event as real messages and outnumbers them.
 */
export function flattenMessage(raw: unknown): WhatsAppMessage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const envelope = raw as Record<string, unknown>;

  const key = envelope["key"];
  if (key === null || typeof key !== "object") return undefined;
  const keyFields = key as Record<string, unknown>;

  const chatJid = typeof keyFields["remoteJid"] === "string" ? keyFields["remoteJid"] : undefined;
  const id = typeof keyFields["id"] === "string" ? keyFields["id"] : undefined;
  if (chatJid === undefined || id === undefined) return undefined;
  // Status broadcasts are everyone's stories, not a conversation.
  if (chatJid === "status@broadcast") return undefined;

  const message = envelope["message"];
  if (message === null || typeof message !== "object") return undefined;
  const messageFields = message as Record<string, unknown>;

  const isFromMe = keyFields["fromMe"] === true;
  // In a group the sender is the participant; in a DM it is the chat itself.
  const participant =
    typeof keyFields["participant"] === "string" ? keyFields["participant"] : undefined;

  const contextInfo = (
    messageFields["extendedTextMessage"] as Record<string, unknown> | undefined
  )?.["contextInfo"] as Record<string, unknown> | undefined;
  const mentions = Array.isArray(contextInfo?.["mentionedJid"])
    ? (contextInfo["mentionedJid"] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const quotedParticipant = contextInfo?.["participant"];

  const text = textOf(messageFields);
  const media = mediaOf(messageFields);
  if (text.trim().length === 0 && media === undefined) return undefined;

  return {
    id,
    chatJid,
    senderJid: participant ?? chatJid,
    pushName: typeof envelope["pushName"] === "string" ? envelope["pushName"] : undefined,
    text,
    isFromMe,
    mentions,
    quotedAuthor:
      typeof quotedParticipant === "string" && quotedParticipant.length > 0
        ? quotedParticipant
        : undefined,
    media,
  };
}

export interface ConnectionOptions {
  /** Directory the linked-device credentials live in. Created if absent. */
  readonly authDir: string;
  /**
   * Log in with an 8-character code typed into WhatsApp instead of a QR.
   *
   * The only workable path on a headless machine, where nobody can point a
   * phone camera at the terminal. The number is the account being linked.
   */
  readonly pairWithNumber: string | undefined;
  readonly onMessage: (message: WhatsAppMessage) => void;
  readonly onReady: (selfJid: string) => void;
  /** A QR string to render, when pairing by code was not requested. */
  readonly onQr: (qr: string) => void;
  /** Terminal: the account was unlinked and the credentials are now useless. */
  readonly onLoggedOut: () => void;
}

export interface Connection {
  send(jid: Jid, text: string): Promise<void>;
  sendFile(jid: Jid, filePath: string, caption: string | undefined): Promise<void>;
  /** Best-effort "typing…" in the chat. */
  typing(jid: Jid): Promise<void>;
  /** Save an inbound attachment to `directory`, returning its path. */
  saveMedia(message: WhatsAppMessage, directory: string): Promise<string | undefined>;
  readonly selfJid: string | undefined;
  close(): void;
}

/** How long to wait before reconnecting after a non-terminal disconnect. */
const RECONNECT_DELAY_MS = 3_000;

export async function connect(options: ConnectionOptions): Promise<Connection> {
  mkdirSync(options.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
  // Pinning the version Baileys reports would get the connection refused as
  // WhatsApp retires it; asking on each connect is what keeps a long-lived
  // bridge from breaking on someone else's schedule.
  const { version } = await fetchLatestBaileysVersion();

  let socket: WASocket | undefined;
  let selfJid: string | undefined;
  let closed = false;

  const start = (): void => {
    if (closed) return;
    socket = makeWASocket({
      auth: state,
      version,
      logger: SILENT_LOGGER,
      browser: ["Jazz", "Chrome", "1.0.0"],
      // The bridge answers when addressed; announcing itself as online would
      // also mark every message read, which changes what the other person sees
      // on their side about whether anyone has looked.
      markOnlineOnConnect: false,
    });

    socket.ev.on("creds.update", () => void saveCreds());

    socket.ev.on("connection.update", (update) => {
      if (update.qr !== undefined && options.pairWithNumber === undefined) {
        options.onQr(update.qr);
      }
      if (update.connection === "open") {
        selfJid = socket?.user?.id;
        options.onReady(selfJid ?? "unknown");
      }
      if (update.connection === "close") {
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          options.onLoggedOut();
          return;
        }
        if (!closed) setTimeout(start, RECONNECT_DELAY_MS);
      }
    });

    socket.ev.on("messages.upsert", (upsert) => {
      // "append" is history being backfilled, not new traffic; answering it
      // would replay old conversations on every reconnect.
      if (upsert.type !== "notify") return;
      for (const raw of upsert.messages) {
        const message = flattenMessage(raw);
        if (message !== undefined) options.onMessage(message);
      }
    });
  };

  start();

  if (options.pairWithNumber !== undefined && !state.creds.registered) {
    // The socket has to exist and be mid-handshake before a code can be asked
    // for, which is why this follows `start()` rather than configuring it.
    const code = await socket?.requestPairingCode(options.pairWithNumber.replace(/\D/g, ""));
    console.error(
      `\nPairing code: ${code}\nWhatsApp → Settings → Linked Devices → Link with phone number\n`,
    );
  }

  const requireSocket = (): WASocket => {
    if (socket === undefined) throw new Error("WhatsApp socket is not connected");
    return socket;
  };

  return {
    get selfJid() {
      return selfJid;
    },
    send: async (jid, text) => {
      await requireSocket().sendMessage(jid, { text });
    },
    sendFile: async (jid, filePath, caption) => {
      const file = Bun.file(filePath);
      const bytes = Buffer.from(await file.arrayBuffer());
      const isImage = (file.type || "").startsWith("image/");
      await requireSocket().sendMessage(
        jid,
        isImage
          ? { image: bytes, ...(caption === undefined ? {} : { caption }) }
          : {
              document: bytes,
              mimetype: file.type || "application/octet-stream",
              fileName: filePath.split("/").at(-1) ?? "file",
              ...(caption === undefined ? {} : { caption }),
            },
      );
    },
    typing: async (jid) => {
      await requireSocket().sendPresenceUpdate("composing", jid);
    },
    saveMedia: async (message, directory) => {
      if (message.media === undefined) return undefined;
      mkdirSync(directory, { recursive: true });
      const bytes = await downloadMediaMessage(
        {
          key: { id: message.id, remoteJid: message.chatJid },
          message: message.media.source,
        },
        "buffer",
        {},
      );
      const extension = message.media.mimeType.split("/").at(-1)?.split(";").at(0) ?? "bin";
      const path = `${directory}/${message.id}.${message.media.fileName?.split(".").at(-1) ?? extension}`;
      await Bun.write(path, bytes as Uint8Array);
      return path;
    },
    close: () => {
      closed = true;
      void socket?.end(undefined);
    },
  };
}

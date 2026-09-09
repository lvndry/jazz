/**
 * @fileoverview Typed access to the `imsg` CLI.
 *
 * Apple ships no iMessage API. The two things that work are reading
 * `~/Library/Messages/chat.db` and driving Messages.app over AppleScript, and
 * both are full of traps: on current macOS a message's text usually is not in
 * `message.text` at all but inside an `attributedBody` NSKeyedArchiver blob,
 * the schema moves between releases, and addressing a group needs the chat's
 * GUID rather than any participant's handle.
 *
 * `imsg` (MIT, `brew install steipete/tap/imsg`) already solves that, emits
 * NDJSON, and is the same tool OpenClaw drives. So this bridge shells out to it
 * rather than re-deriving Apple's schema, and this module is the whole of that
 * dependency: every field name and flag `imsg` owns is named here and nowhere
 * else, so a change on its side is a change in one file.
 *
 * Only the "standard" capability tier is used — `chats`, `watch`, `send`. The
 * richer verbs (edit, unsend, typing indicators, tapback-by-GUID) need SIP
 * disabled, which is not something a chat bridge should ask of a machine.
 */

/** One message row, as `imsg` prints it. Fields we do not act on are omitted. */
export interface ImsgMessage {
  /** `chat.db` rowid. Doubles as the watch cursor — see `--since-rowid`. */
  readonly id: number;
  readonly chatId: number;
  readonly guid: string;
  /** The sender's handle: a phone number in E.164, or an Apple ID email. */
  readonly sender: string;
  /** Resolved from Contacts when that permission was granted. */
  readonly senderName: string | undefined;
  readonly isFromMe: boolean;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: readonly ImsgAttachment[];
  /** True for a tapback row, which is an event about another message. */
  readonly isReaction: boolean;
  readonly replyToText: string | undefined;
}

export interface ImsgAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly isSticker: boolean;
  /** Absolute path under `~/Library/Messages/Attachments`. */
  readonly originalPath: string;
  /** Set when `--convert-attachments` transcoded it (CAF→M4A, GIF→PNG). */
  readonly convertedPath: string | undefined;
  /** The row survived but the file did not; reading `originalPath` will fail. */
  readonly missing: boolean;
}

export interface ImsgChat {
  /** `chat.db` rowid — stable on this machine and the handle `--chat-id` takes. */
  readonly id: number;
  readonly name: string;
  /** Portable across machines, unlike `id`: a handle for a DM, a GUID for a group. */
  readonly identifier: string;
  readonly guid: string | undefined;
  readonly displayName: string | undefined;
  readonly contactName: string | undefined;
  readonly isGroup: boolean;
  readonly participants: readonly string[];
  readonly service: string;
}

/** Where a send is addressed. A group has no unambiguous address, so it must go by chat. */
export type ImsgTarget =
  | { readonly kind: "chat"; readonly chatId: number }
  | { readonly kind: "address"; readonly address: string };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAttachment(raw: Record<string, unknown>): ImsgAttachment {
  return {
    filename: asString(raw["filename"]) ?? "",
    mimeType: asString(raw["mime_type"]) ?? "application/octet-stream",
    totalBytes: asNumber(raw["total_bytes"]) ?? 0,
    isSticker: raw["is_sticker"] === true,
    originalPath: asString(raw["original_path"]) ?? "",
    convertedPath: asString(raw["converted_path"]),
    missing: raw["missing"] === true,
  };
}

/**
 * Parse one NDJSON line into a message, or undefined when it is not one.
 *
 * `imsg` puts warnings on stderr and JSON on stdout, but a line still has to
 * survive a version skew where a field we depend on is missing: a bridge that
 * threw on an unexpected row would stop reading the stream and go silent, which
 * is a worse failure than skipping the row.
 */
export function parseMessageLine(line: string): ImsgMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const id = asNumber(raw["id"]);
  const chatId = asNumber(raw["chat_id"]);
  if (id === undefined || chatId === undefined) return undefined;

  const attachments = Array.isArray(raw["attachments"])
    ? (raw["attachments"] as unknown[])
        .filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        )
        .map(parseAttachment)
    : [];

  return {
    id,
    chatId,
    guid: asString(raw["guid"]) ?? "",
    sender: asString(raw["sender"]) ?? "",
    senderName: asString(raw["sender_name"]),
    isFromMe: raw["is_from_me"] === true,
    text: typeof raw["text"] === "string" ? raw["text"] : "",
    createdAt: asString(raw["created_at"]) ?? new Date().toISOString(),
    attachments,
    isReaction: raw["is_reaction"] === true,
    replyToText: asString(raw["reply_to_text"]),
  };
}

export function parseChatLine(line: string): ImsgChat | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const id = asNumber(raw["id"]);
  if (id === undefined) return undefined;

  return {
    id,
    name: asString(raw["name"]) ?? "",
    identifier: asString(raw["identifier"]) ?? "",
    guid: asString(raw["guid"]),
    displayName: asString(raw["display_name"]),
    contactName: asString(raw["contact_name"]),
    isGroup: raw["is_group"] === true,
    participants: Array.isArray(raw["participants"])
      ? (raw["participants"] as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    service: asString(raw["service"]) ?? "iMessage",
  };
}

/**
 * The name a human would recognise this chat by, best available.
 *
 * Each candidate is skipped when it is blank, not merely when it is absent: a
 * chat with no title comes back with `name` set to the empty string rather than
 * missing, and `??` would happily return that as the label.
 */
export function chatLabel(chat: ImsgChat): string {
  const candidates = [chat.contactName, chat.displayName, chat.name, chat.identifier];
  return candidates.find((candidate) => candidate !== undefined && candidate.length > 0) ?? "";
}

async function runImsg(
  binary: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export interface ImsgAvailability {
  readonly available: boolean;
  /** Why it is unusable, ready to put in front of an operator. */
  readonly reason?: string;
}

/**
 * Check that `imsg` is installed and can actually read the message database.
 *
 * Both halves matter and fail differently: a missing binary is an install step,
 * while a binary that runs but reads nothing is almost always Full Disk Access
 * not granted to whatever launched this process — a permission a person has to
 * grant in System Settings, so the bridge has to say which one rather than
 * looping on an empty stream.
 */
export async function checkImsg(binary: string): Promise<ImsgAvailability> {
  let probe: { stdout: string; stderr: string; exitCode: number };
  try {
    probe = await runImsg(binary, ["chats", "--limit", "1", "--json"]);
  } catch {
    return {
      available: false,
      reason: `\`${binary}\` is not on PATH. Install it with: brew install steipete/tap/imsg`,
    };
  }

  if (probe.exitCode !== 0) {
    const detail = probe.stderr.trim().split("\n").at(0) ?? `exit ${probe.exitCode}`;
    return {
      available: false,
      reason:
        `\`${binary} chats\` failed: ${detail}\n` +
        "If it mentions authorization, grant Full Disk Access to whatever runs this bridge " +
        "(System Settings → Privacy & Security → Full Disk Access), then start it again.",
    };
  }

  return { available: true };
}

export async function listChats(binary: string, limit: number): Promise<ImsgChat[]> {
  const { stdout } = await runImsg(binary, ["chats", "--limit", String(limit), "--json"]);
  return stdout
    .split("\n")
    .map(parseChatLine)
    .filter((chat): chat is ImsgChat => chat !== undefined);
}

/** Build the `--chat-id`/`--to` pair for a target, so callers never spell it twice. */
function targetArgs(target: ImsgTarget): string[] {
  return target.kind === "chat" ? ["--chat-id", String(target.chatId)] : ["--to", target.address];
}

export async function sendText(binary: string, target: ImsgTarget, body: string): Promise<void> {
  const { exitCode, stderr } = await runImsg(binary, [
    "send",
    ...targetArgs(target),
    "--text",
    body,
  ]);
  if (exitCode !== 0) {
    throw new Error(`imsg send failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

export async function sendFile(
  binary: string,
  target: ImsgTarget,
  filePath: string,
): Promise<void> {
  const { exitCode, stderr } = await runImsg(binary, [
    "send",
    ...targetArgs(target),
    "--file",
    filePath,
  ]);
  if (exitCode !== 0) {
    throw new Error(`imsg send --file failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

export interface WatchHandle {
  stop(): void;
}

export interface WatchOptions {
  readonly binary: string;
  /** Resume point: only rows after this are delivered. */
  readonly sinceRowId: number | undefined;
  readonly includeAttachments: boolean;
  readonly onMessage: (message: ImsgMessage) => void;
  /** Called when the watcher dies and is about to be restarted. */
  readonly onRestart: (reason: string) => void;
}

/** How long to wait before respawning a watcher that exited. */
const WATCH_RESTART_DELAY_MS = 3_000;

/**
 * Follow new messages, restarting the watcher if it dies.
 *
 * `imsg watch` is a long-lived child that can end for reasons outside this
 * process — a Messages.app relaunch, the database being replaced under it, a
 * crash. Since the cursor advances as rows arrive, a restart resumes from the
 * last row actually handled rather than replaying the backlog or skipping it.
 */
export function watchMessages(options: WatchOptions): WatchHandle {
  let stopped = false;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let cursor = options.sinceRowId;

  const spawnWatcher = () => {
    if (stopped) return;
    const args = [
      "watch",
      "--json",
      ...(cursor === undefined ? [] : ["--since-rowid", String(cursor)]),
      ...(options.includeAttachments ? ["--attachments"] : []),
    ];
    child = Bun.spawn([options.binary, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = child.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const message = parseMessageLine(buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (message === undefined) continue;
            // Advance before handling: a handler that throws must not make the
            // same row arrive again on the next restart, forever.
            cursor = Math.max(cursor ?? 0, message.id);
            options.onMessage(message);
          }
        }
      } catch (error) {
        if (!stopped) console.error(`imsg watch stream error: ${String(error)}`);
      } finally {
        reader.releaseLock();
      }
    })();

    void child.exited.then((exitCode) => {
      if (stopped) return;
      options.onRestart(`imsg watch exited (${exitCode})`);
      setTimeout(spawnWatcher, WATCH_RESTART_DELAY_MS);
    });
  };

  spawnWatcher();

  return {
    stop: () => {
      stopped = true;
      child?.kill();
    },
  };
}

/**
 * Append-only conversation logs — the whole of Jazz's conversation history.
 *
 * One conversation is one file of newline-delimited JSON events at
 * `{historyDirectory}/conversations/{agentId}/{conversationId}.jsonl`. A turn is
 * recorded by appending what is new, so a save costs what changed rather than the
 * length of the conversation.
 *
 * There is no index. An earlier design kept one per agent to avoid reading the logs, then
 * read every log anyway to fill the transcripts back in — so it bought nothing and cost a
 * lock file, an atomic rewrite, a rebuild path, and a second source of truth that could
 * disagree with the first. Reading a whole history measures in single-digit milliseconds;
 * the directory is the index.
 *
 * Three properties matter more than elegance:
 *
 * - **Crash tolerance.** A process killed mid-write leaves a partial final line. Readers
 *   drop unparseable lines rather than rejecting the file, and the next append
 *   re-terminates the record, so at most the interrupted turn is lost.
 * - **Monotonic history.** Nothing is rewritten in place. Compaction, which legitimately
 *   replaces the transcript, appends a `rewrite` marker: readers reset their accumulator
 *   and the superseded lines stay on disk where search can still find them.
 * - **Only what was said.** System prompts are not recorded. They are rebuilt from the
 *   persona, tools and skills on every run, so a stored copy is stale the moment it lands,
 *   and the one reader that ever saw them filtered them straight back out.
 *
 * The UI scrollback follows the same rule as messages. A save appends a `ui-append` event
 * with the entries added since the last save, and writes a full `ui-transcript` snapshot only
 * when the scrollback no longer extends what the log holds (after `/clear`, or when a resumed
 * session re-renders it). Snapshots supersede everything before them, so the first save of a
 * process that finds superseded UI events rewrites the log once without them.
 *
 * A save needs to know what the log already holds. The process that last wrote a log caches
 * that, keyed by the file's size, modification time and inode, so a chat that saves every
 * turn reads its log once rather than once per turn. Any other writer changes the key, and
 * the next save reads the file again.
 */
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { FileSystem } from "@effect/platform";
import { isTerminalOutputKind } from "@jazz/core/interfaces/terminal";
import type { ChatMessage } from "@jazz/core/types/message";
import type { PresentationEntry } from "@jazz/core/types/presentation-content";
import { presentationEntrySchema } from "@jazz/core/types/presentation-content-schema";
import { toError } from "@jazz/core/utils/errors";
import { getHistoryDirectory } from "@jazz/core/utils/paths";
import { stateDirectoryMode, stateFileMode } from "@jazz/core/utils/private-mode";
import { writeFileStringAtomic } from "@jazz/core/utils/storage";
import { storageSafeSegment } from "@jazz/core/utils/storage-id";
import { Effect, Option } from "effect";

const CONVERSATION_LOCKS_DIRECTORY_NAME = "conversation-locks";

/**
 * Schema version stamped on every header.
 *
 * 3 stores semantic presentation entries with source IDs and structured facts.
 * Version 2 UI text remains readable; the next save upgrades it atomically.
 *
 * 2 dropped the derived `conversationId` field, stopped recording system messages, and moved
 * from one flat directory of `{agent}~{conversation}.jsonl` to a directory per agent.
 *
 * The version only guards events this version may misread or, by appending, corrupt.
 */
export const CONVERSATION_LOG_VERSION = 3;

const CONVERSATIONS_DIRECTORY_NAME = "conversations";
const CONVERSATION_LOG_EXTENSION = ".jsonl";
const ARCHIVE_DIRECTORY_NAME = "archive";
const ARCHIVED_LOG_EXTENSION = ".jsonl.gz";

/** Characters of a message compared when checking whether a log still matches a transcript. */
const MESSAGE_FINGERPRINT_CHARS = 12;

/** Characters of the first user message used when a conversation was never given a title. */
const DERIVED_TITLE_CHARS = 48;

/** Bytes read at a time while looking for the end of a log's header line. */
const HEADER_READ_CHUNK_BYTES = 4096;

/** Logs whose append state one process keeps; a chat touches one, a daemon a handful. */
const MAX_CACHED_APPEND_STATES = 64;

function fingerprint(value: string, chars: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, chars);
}

/** Directory holding every agent's conversation logs. */
export function getConversationLogsDirectory(historyDirectory?: string): string {
  return path.join(historyDirectory ?? getHistoryDirectory(), CONVERSATIONS_DIRECTORY_NAME);
}

/** Directory holding one agent's conversation logs. */
export function agentConversationsDirectory(agentId: string, historyDirectory?: string): string {
  return path.join(getConversationLogsDirectory(historyDirectory), storageSafeSegment(agentId));
}

/** Path of one conversation's log. */
export function conversationLogPath(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): string {
  return path.join(
    agentConversationsDirectory(agentId, historyDirectory),
    `${storageSafeSegment(conversationId)}${CONVERSATION_LOG_EXTENSION}`,
  );
}

/** Directory under the history directory where archived conversations and legacy files go. */
export function getHistoryArchiveDirectory(historyDirectory?: string): string {
  return path.join(historyDirectory ?? getHistoryDirectory(), ARCHIVE_DIRECTORY_NAME);
}

/** Where one conversation's log is kept, gzip-compressed, once it is archived. */
export function archivedConversationLogPath(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): string {
  return path.join(
    getHistoryArchiveDirectory(historyDirectory),
    CONVERSATIONS_DIRECTORY_NAME,
    storageSafeSegment(agentId),
    `${storageSafeSegment(conversationId)}${ARCHIVED_LOG_EXTENSION}`,
  );
}

/** Cross-process lock path for one agent's saves; kept out of `conversations/` so listing never sees it. */
export function agentConversationLockPath(agentId: string, historyDirectory?: string): string {
  return path.join(
    historyDirectory ?? getHistoryDirectory(),
    CONVERSATION_LOCKS_DIRECTORY_NAME,
    `${storageSafeSegment(agentId)}.lock`,
  );
}

export interface ConversationLogHeader {
  readonly type: "conversation";
  readonly version: number;
  readonly agentId: string;
  readonly conversationId: string;
  readonly startedAt: string;
  readonly title?: string;
}

export interface ConversationLogMessage {
  readonly type: "message";
  readonly at: string;
  readonly message: ChatMessage;
}

export interface ConversationLogMeta {
  readonly type: "meta";
  readonly at: string;
  readonly title?: string;
}

/** Compaction replaced the transcript; readers reset and keep only what follows. */
export interface ConversationLogRewrite {
  readonly type: "rewrite";
  readonly at: string;
}

/**
 * A full snapshot of the UI-only scrollback, deliberately separate from model-facing messages.
 * Readers replace whatever scrollback they had accumulated.
 */
export interface ConversationLogUiTranscript {
  readonly type: "ui-transcript";
  readonly at: string;
  readonly entries: readonly ConversationUiEntry[];
}

/** Scrollback entries added since the previous save. Readers append them. */
export interface ConversationLogUiAppend {
  readonly type: "ui-append";
  readonly at: string;
  readonly entries: readonly ConversationUiEntry[];
}

export type ConversationLogEvent =
  | ConversationLogHeader
  | ConversationLogMessage
  | ConversationLogMeta
  | ConversationLogRewrite
  | ConversationLogUiTranscript
  | ConversationLogUiAppend;

export type ConversationUiEntry = PresentationEntry;

/** A conversation and everything said in it. */
export interface Conversation {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  /** When the newest message was recorded, or null before anything was said. */
  readonly lastMessageAt: string | null;
  readonly messages: ChatMessage[];
  /** Semantic UI scrollback snapshot, kept separate from messages and never sent to the model. */
  readonly uiTranscript?: readonly ConversationUiEntry[];
}

/** A conversation as handed to a save: the log stamps each message with when it was recorded. */
export type ConversationToSave = Omit<Conversation, "lastMessageAt">;

/**
 * A conversation without its transcript.
 *
 * A separate type rather than a `Conversation` with an empty `messages`, because that
 * convention cannot distinguish "not loaded" from "nothing was said" and every caller has
 * to know which one it is holding.
 */
export interface ConversationSummary {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  /** When the newest message was recorded, or null before anything was said. */
  readonly lastMessageAt: string | null;
  readonly messageCount: number;
}

export interface ConversationLogFileInfo {
  readonly agentId: string;
  readonly conversationId: string;
  readonly filePath: string;
  readonly modifiedAtMs: number;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses one log line, returning `null` for anything unrecognizable.
 *
 * A truncated final line from a killed process lands here as a JSON syntax error; treating
 * it as "no event" is what keeps one bad write from poisoning the whole log.
 * UI batches are atomic: an invalid entry or duplicate ID rejects the event.
 * Standalone calls use version 3; only an explicit version 2 context decodes legacy text.
 */
export function parseConversationLogLine(
  line: string,
  recordIndex = 0,
  version = CONVERSATION_LOG_VERSION,
): ConversationLogEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecordObject(parsed)) return null;

  const at = optionalString(parsed["at"]) ?? new Date(0).toISOString();
  switch (parsed["type"]) {
    case "conversation": {
      const agentId = optionalString(parsed["agentId"]);
      const conversationId = optionalString(parsed["conversationId"]);
      if (!agentId || !conversationId) return null;
      const title = optionalString(parsed["title"]);
      return {
        type: "conversation",
        version:
          typeof parsed["version"] === "number" ? parsed["version"] : CONVERSATION_LOG_VERSION,
        agentId,
        conversationId,
        startedAt: optionalString(parsed["startedAt"]) ?? at,
        ...(title === undefined ? {} : { title }),
      };
    }
    case "message": {
      const message = parsed["message"];
      if (!isRecordObject(message) || typeof message["content"] !== "string") return null;
      const role = message["role"];
      // `system` is absent by design, and a log carrying one is from a format that no
      // longer exists — drop it rather than replay a stale prompt into a transcript.
      if (role !== "user" && role !== "assistant" && role !== "tool") return null;
      // `role`/`content` are checked above, but narrowing a variable read out of `message`
      // doesn't narrow `message` itself — the checks already guarantee this at runtime.
      return { type: "message", at, message: message as unknown as ChatMessage };
    }
    case "meta": {
      const title = optionalString(parsed["title"]);
      if (title === undefined) return null;
      return { type: "meta", at, title };
    }
    case "rewrite":
      return { type: "rewrite", at };
    case "ui-transcript":
    case "ui-append": {
      const entries = parsed["entries"];
      if (!Array.isArray(entries)) return null;
      const accepted: ConversationUiEntry[] = [];
      const ids = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        const validated = presentationEntrySchema.safeParse(entry);
        let source: ConversationUiEntry;
        if (validated.success) {
          source = validated.data;
        } else {
          if (
            version !== 2 ||
            !isRecordObject(entry) ||
            Object.keys(entry).some((key) => key !== "type" && key !== "message") ||
            typeof entry["message"] !== "string" ||
            !isTerminalOutputKind(entry["type"])
          )
            return null;
          const type = entry["type"];
          const text = Bun.stripANSI(entry["message"]);
          source = {
            id: `legacy:${recordIndex}:${index}`,
            timestamp: Number.isNaN(Date.parse(at))
              ? new Date(0).toISOString()
              : new Date(at).toISOString(),
            content:
              type === "user"
                ? { kind: "user", text }
                : { kind: "notice", text, tone: type === "streamContent" ? "log" : type },
          };
        }
        if (ids.has(source.id)) return null;
        ids.add(source.id);
        accepted.push(source);
      }
      return { type: parsed["type"], at, entries: accepted };
    }
    default:
      return null;
  }
}

/** Accept all IDs or leave the current set unchanged when any entry conflicts. */
function acceptUiEntryIds(entries: readonly ConversationUiEntry[], ids: Set<string>): boolean {
  const added = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id) || added.has(entry.id)) return false;
    added.add(entry.id);
  }
  for (const id of added) ids.add(id);
  return true;
}

/** Retain line positions while applying the header version and atomic UI identity boundary. */
function parseConversationLogRecords(lines: readonly string[]): (ConversationLogEvent | null)[] {
  let version = CONVERSATION_LOG_VERSION;
  let uiIds = new Set<string>();
  return lines.map((line, index) => {
    const event = parseConversationLogLine(line, index, version);
    if (event?.type === "conversation") version = event.version;
    if (event?.type === "ui-transcript" || event?.type === "ui-append") {
      const nextIds = event.type === "ui-transcript" ? new Set<string>() : uiIds;
      if (!acceptUiEntryIds(event.entries, nextIds)) return null;
      uiIds = nextIds;
    }
    return event;
  });
}

/** First line of the first user message, used when a conversation has no title. */
export function deriveConversationTitle(
  title: string | undefined,
  messages: readonly ChatMessage[],
): string {
  const explicit = title?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const firstUserMessage = messages.find((message) => message.role === "user");
  // The model-facing content can carry an appended memory-source tag; the source holds
  // exactly what the person typed.
  const typed = firstUserMessage?.memorySource?.text ?? firstUserMessage?.content ?? "";
  const firstLine = typed.replace(/\s+/g, " ").trim();
  if (firstLine.length === 0) return "untitled conversation";
  return firstLine.length > DERIVED_TITLE_CHARS
    ? `${firstLine.slice(0, DERIVED_TITLE_CHARS - 1).trimEnd()}…`
    : firstLine;
}

/** Folds a log's events into the conversation's current state. */
export function reduceConversationLog(
  events: readonly ConversationLogEvent[],
): Conversation | null {
  let header: ConversationLogHeader | null = null;
  let title: string | undefined;
  let lastMessageAt: string | null = null;
  let messages: ChatMessage[] = [];
  let uiTranscript: ConversationUiEntry[] = [];
  let uiIds = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "conversation":
        header = event;
        title = event.title ?? title;
        break;
      case "message":
        messages.push(event.message);
        lastMessageAt = event.at;
        break;
      case "meta":
        if (event.title !== undefined) title = event.title;
        break;
      case "rewrite":
        messages = [];
        break;
      case "ui-transcript": {
        const nextIds = new Set<string>();
        if (!acceptUiEntryIds(event.entries, nextIds)) break;
        uiIds = nextIds;
        uiTranscript = [...event.entries];
        break;
      }
      case "ui-append":
        if (!acceptUiEntryIds(event.entries, uiIds)) break;
        uiTranscript.push(...event.entries);
        break;
    }
  }

  if (!header) return null;
  return {
    agentId: header.agentId,
    conversationId: header.conversationId,
    title: deriveConversationTitle(title, messages),
    startedAt: header.startedAt,
    lastMessageAt,
    messages,
    uiTranscript,
  };
}

export function summarize(conversation: Conversation): ConversationSummary {
  return {
    agentId: conversation.agentId,
    conversationId: conversation.conversationId,
    title: conversation.title,
    startedAt: conversation.startedAt,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messages.length,
  };
}

function readLogContent(
  fs: FileSystem.FileSystem,
  logPath: string,
): Effect.Effect<string | null, never> {
  return fs.readFileString(logPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/**
 * The first line of a file, read in small chunks so listing a directory of long logs costs
 * their headers rather than their whole bodies. Null when the file cannot be read.
 */
async function readFirstLine(filePath: string): Promise<string | null> {
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(filePath, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const chunk = Buffer.alloc(HEADER_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, HEADER_READ_CHUNK_BYTES, position);
      if (bytesRead === 0) {
        return Buffer.concat(chunks).toString("utf-8");
      }
      const read = chunk.subarray(0, bytesRead);
      const newline = read.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(read.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf-8");
      }
      chunks.push(read);
      position += bytesRead;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Refuses a log whose header was written by a newer Jazz, whose events this version may
 * misread or, by appending, corrupt.
 */
function requireReadableLogVersion(
  events: readonly ConversationLogEvent[],
  logPath: string,
): Effect.Effect<void, Error> {
  const header = events.find((event) => event.type === "conversation");
  return header !== undefined && header.version > CONVERSATION_LOG_VERSION
    ? Effect.fail(
        new Error(
          `${logPath} was written by a newer version of Jazz (log version ${header.version}; this version reads up to ${CONVERSATION_LOG_VERSION}). Update Jazz to open it.`,
        ),
      )
    : Effect.void;
}

/** Parses a log body into events, skipping lines a crash left unreadable. */
export function parseConversationLog(content: string): ConversationLogEvent[] {
  return parseConversationLogRecords(content.split("\n")).filter((event) => event !== null);
}

/** Reads a whole conversation log and folds it into a conversation. */
export function readConversationLog(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): Effect.Effect<Conversation | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logPath = conversationLogPath(agentId, conversationId, historyDirectory);
    const content = yield* readLogContent(fs, logPath);
    if (content === null) return null;
    const events = parseConversationLog(content);
    yield* requireReadableLogVersion(events, logPath);
    return reduceConversationLog(events);
  });
}

/**
 * One agent's conversation logs, newest-modified first.
 *
 * The ids come from each file's header rather than its path: `storageSafeSegment` is lossy,
 * so a path can name a conversation without being able to reproduce its id.
 */
export function listConversationLogs(
  agentId: string,
  historyDirectory?: string,
): Effect.Effect<ConversationLogFileInfo[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = agentConversationsDirectory(agentId, historyDirectory);
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));

    const infos: ConversationLogFileInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(CONVERSATION_LOG_EXTENSION)) continue;
      const filePath = path.join(directory, name);
      const info = yield* fs.stat(filePath).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!info || info.type !== "File") continue;

      const headerLine = yield* Effect.promise(() => readFirstLine(filePath));
      if (headerLine === null) continue;
      const header = parseConversationLogLine(headerLine);
      if (header?.type !== "conversation") continue;

      infos.push({
        agentId: header.agentId,
        conversationId: header.conversationId,
        filePath,
        modifiedAtMs: Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
      });
    }

    return infos.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  });
}

/** How many conversation logs an agent has, from the directory listing alone. */
export function countConversationLogs(
  agentId: string,
  historyDirectory?: string,
): Effect.Effect<number, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(agentConversationsDirectory(agentId, historyDirectory))
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    return names.filter((name) => name.endsWith(CONVERSATION_LOG_EXTENSION)).length;
  });
}

/** Every agent that has conversation logs on disk. */
export function listAgentsWithConversations(
  historyDirectory?: string,
): Effect.Effect<string[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = getConversationLogsDirectory(historyDirectory);
    const names = yield* fs
      .readDirectory(root)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));

    const agents: string[] = [];
    for (const name of names) {
      const info = yield* fs
        .stat(path.join(root, name))
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (info?.type === "Directory") agents.push(name);
    }
    return agents;
  });
}

/** Removes one conversation log. Nothing else references it, so this is the whole delete. */
export function deleteConversationLog(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logPath = conversationLogPath(agentId, conversationId, historyDirectory);
    appendStateCache.delete(logPath);
    yield* fs.remove(logPath).pipe(Effect.catchAll(() => Effect.void));
  });
}

/**
 * Moves one conversation's log out of the live history into the archive, gzip-compressed.
 * The compressed copy is written atomically before the live log is removed, so a crash
 * leaves the conversation in one place or both, never neither. Returns the archive path, or
 * null when there was no log to archive.
 */
export function archiveConversationLog(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): Effect.Effect<string | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logPath = conversationLogPath(agentId, conversationId, historyDirectory);
    const content = yield* fs.readFile(logPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) {
      return null;
    }
    const archivePath = archivedConversationLogPath(agentId, conversationId, historyDirectory);
    const temporaryPath = `${archivePath}.${process.pid}.tmp`;
    yield* fs
      .makeDirectory(path.dirname(archivePath), { recursive: true, mode: stateDirectoryMode() })
      .pipe(Effect.mapError(toError));
    yield* fs
      .writeFile(temporaryPath, gzipSync(content), { mode: stateFileMode() })
      .pipe(Effect.mapError(toError));
    yield* fs.rename(temporaryPath, archivePath).pipe(
      Effect.tapError(() => fs.remove(temporaryPath).pipe(Effect.catchAll(() => Effect.void))),
      Effect.mapError(toError),
    );
    appendStateCache.delete(logPath);
    yield* fs.remove(logPath).pipe(Effect.mapError(toError));
    return archivePath;
  });
}

interface AppendState {
  readonly messageCount: number;
  readonly lastMessageFingerprint: string;
  readonly title: string;
  readonly uiEntryCount: number;
  readonly uiEntryFingerprints: readonly string[];
}

function messageFingerprint(message: ChatMessage): string {
  return `${message.role}:${message.content.length}:${fingerprint(message.content, MESSAGE_FINGERPRINT_CHARS)}`;
}

function fingerprintAt(messages: readonly ChatMessage[], index: number): string {
  const message = messages[index];
  return message ? messageFingerprint(message) : "";
}

/** Entries are immutable source facts, so unchanged entries need no repeat serialization. */
const uiEntryFingerprints = new WeakMap<ConversationUiEntry, string>();
const validatedUiEntries = new WeakSet<ConversationUiEntry>();

function uiEntryFingerprint(entry: ConversationUiEntry): string {
  const cached = uiEntryFingerprints.get(entry);
  if (cached !== undefined) return cached;
  const result = createHash("sha256")
    .update(JSON.stringify(presentationEntrySchema.parse(entry)))
    .digest("hex");
  uiEntryFingerprints.set(entry, result);
  return result;
}

/** Compare every persisted entry: changing an earlier fact must replace the snapshot too. */
function uiPrefixHolds(
  entries: readonly ConversationUiEntry[],
  previous: readonly string[],
): boolean {
  return (
    entries.length >= previous.length &&
    previous.every((hash, index) => {
      const entry = entries[index];
      return entry !== undefined && uiEntryFingerprint(entry) === hash;
    })
  );
}

function serializeEvent(event: ConversationLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isUiEvent(event: ConversationLogEvent | null): boolean {
  return event?.type === "ui-transcript" || event?.type === "ui-append";
}

/** What identifies one version of a log file on disk, so a cached append state can be trusted. */
interface LogFileIdentity {
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly inode: number;
}

function sameIdentity(left: LogFileIdentity, right: LogFileIdentity): boolean {
  return (
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.inode === right.inode
  );
}

interface CachedAppendState {
  readonly identity: LogFileIdentity;
  readonly state: AppendState;
}

/**
 * Append state for logs this process wrote last, in least-recently-saved order. See the file
 * header for why it is safe: an entry is used only while the file on disk is byte-for-byte
 * the one this process left behind.
 */
const appendStateCache = new Map<string, CachedAppendState>();

function rememberAppendState(logPath: string, cached: CachedAppendState): void {
  appendStateCache.delete(logPath);
  appendStateCache.set(logPath, cached);
  while (appendStateCache.size > MAX_CACHED_APPEND_STATES) {
    const oldest = appendStateCache.keys().next();
    if (oldest.done === true) {
      break;
    }
    appendStateCache.delete(oldest.value);
  }
}

function statLogFile(
  fs: FileSystem.FileSystem,
  logPath: string,
): Effect.Effect<LogFileIdentity | null, never> {
  return fs.stat(logPath).pipe(
    Effect.map((info): LogFileIdentity => ({
      size: Number(info.size),
      modifiedAtMs: Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      }),
      inode: Option.getOrElse(info.ino, () => 0),
    })),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

interface LoadedAppendState {
  /** Null when the file is absent, empty, or holds no readable header. */
  readonly state: AppendState | null;
  readonly needsLeadingNewline: boolean;
}

/**
 * The log with every UI event that a later snapshot supersedes removed, or null when there is
 * nothing to remove. Other lines, unreadable ones included, are kept byte for byte.
 */
export function collapseSupersededUiEvents(content: string): string | null {
  const lines = content.split("\n");
  const events = parseConversationLogRecords(lines);
  let lastSnapshot = -1;
  events.forEach((event, index) => {
    if (event?.type === "ui-transcript") {
      lastSnapshot = index;
    }
  });
  const supersededCount = events.filter(
    (event, index) => index < lastSnapshot && isUiEvent(event),
  ).length;
  if (supersededCount === 0) {
    return null;
  }
  return lines
    .filter((_line, index) => index >= lastSnapshot || !isUiEvent(events[index] ?? null))
    .join("\n");
}

/** Upgrade text-only UI records once; unknown and model-facing lines retain their bytes. */
export function migratePresentationLog(content: string): string | null {
  const lines = content.split("\n");
  const events = parseConversationLogRecords(lines);
  const header = events.find((event) => event?.type === "conversation");
  if (header?.type !== "conversation" || header.version >= CONVERSATION_LOG_VERSION) return null;
  return lines
    .map((line, index) => {
      const event = events[index];
      if (event?.type === "conversation")
        return JSON.stringify({ ...event, version: CONVERSATION_LOG_VERSION });
      if (event?.type === "ui-transcript" || event?.type === "ui-append")
        return JSON.stringify(event);
      return line;
    })
    .join("\n");
}

function appendStateFromContent(content: string): AppendState | null {
  const conversation = reduceConversationLog(parseConversationLog(content));
  if (!conversation) return null;
  const uiTranscript = conversation.uiTranscript ?? [];
  return {
    messageCount: conversation.messages.length,
    lastMessageFingerprint: fingerprintAt(conversation.messages, conversation.messages.length - 1),
    title: conversation.title,
    uiEntryCount: uiTranscript.length,
    uiEntryFingerprints: uiTranscript.map(uiEntryFingerprint),
  };
}

function loadAppendState(
  fs: FileSystem.FileSystem,
  logPath: string,
): Effect.Effect<LoadedAppendState, Error> {
  return Effect.gen(function* () {
    const identity = yield* statLogFile(fs, logPath);
    const cached = appendStateCache.get(logPath);
    if (identity !== null && cached !== undefined && sameIdentity(cached.identity, identity)) {
      return { state: cached.state, needsLeadingNewline: false };
    }
    appendStateCache.delete(logPath);

    const read = yield* readLogContent(fs, logPath);
    if (read === null) return { state: null, needsLeadingNewline: false };

    yield* requireReadableLogVersion(parseConversationLog(read), logPath);
    let content = migratePresentationLog(read) ?? read;
    const collapsed = collapseSupersededUiEvents(content);
    if (collapsed !== null) content = collapsed;
    if (content !== read) {
      yield* writeFileStringAtomic(logPath, content, {
        mode: stateFileMode(),
      });
    }

    // A crash can leave the last line half-written; the next append has to start on a
    // fresh line or it would corrupt an otherwise readable record too.
    const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
    return { state: appendStateFromContent(content), needsLeadingNewline };
  });
}

export interface ConversationTranscriptInput {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly messages: readonly ChatMessage[];
  readonly uiTranscript?: readonly ConversationUiEntry[];
}

/**
 * Records the current state of a conversation, appending only what is new.
 *
 * Callers hand over the whole transcript — that is the shape the chat loop already has —
 * and this compares it against the log and appends the tail. When the prefix no longer
 * matches, because compaction replaced the transcript, a `rewrite` marker and the full new
 * transcript are appended instead. The UI scrollback is compared the same way: new entries
 * are appended as `ui-append`, and a scrollback that no longer extends the logged one is
 * written as a fresh `ui-transcript` snapshot.
 */
export function recordConversationTranscript(
  input: ConversationTranscriptInput,
  historyDirectory?: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logPath = conversationLogPath(input.agentId, input.conversationId, historyDirectory);

    // Dropped before anything else so the append bookkeeping counts the same messages a
    // reader will see. The system prompt is rebuilt from the persona, tools and skills on
    // every run, so recording one stores a copy that is already stale.
    const messages = input.messages.filter((message) => message.role !== "system");
    if (input.uiTranscript !== undefined) {
      const ids = new Set<string>();
      for (const entry of input.uiTranscript) {
        const valid =
          validatedUiEntries.has(entry) || presentationEntrySchema.safeParse(entry).success;
        if (!valid || ids.has(entry.id)) {
          return yield* Effect.fail(
            new Error("Invalid or duplicate presentation entry in conversation history"),
          );
        }
        ids.add(entry.id);
        validatedUiEntries.add(entry);
      }
    }

    yield* fs
      .makeDirectory(path.dirname(logPath), { recursive: true, mode: stateDirectoryMode() })
      .pipe(Effect.mapError(toError));

    const loaded = yield* loadAppendState(fs, logPath);

    let state = loaded.state;
    const chunks: string[] = [];
    if (loaded.needsLeadingNewline) chunks.push("\n");

    if (!state) {
      const title = input.title.trim();
      chunks.push(
        serializeEvent({
          type: "conversation",
          version: CONVERSATION_LOG_VERSION,
          agentId: input.agentId,
          conversationId: input.conversationId,
          startedAt: input.startedAt,
          ...(title.length === 0 ? {} : { title }),
        }),
      );
      state = {
        messageCount: 0,
        lastMessageFingerprint: "",
        title: deriveConversationTitle(title, messages),
        uiEntryCount: 0,
        uiEntryFingerprints: [],
      };
    }

    const prefixHolds =
      messages.length >= state.messageCount &&
      fingerprintAt(messages, state.messageCount - 1) === state.lastMessageFingerprint;

    const now = new Date().toISOString();
    let firstNewMessage = state.messageCount;
    if (!prefixHolds) {
      chunks.push(serializeEvent({ type: "rewrite", at: now }));
      firstNewMessage = 0;
    }

    for (let index = firstNewMessage; index < messages.length; index++) {
      const message = messages[index];
      if (!message) continue;
      chunks.push(serializeEvent({ type: "message", at: now, message }));
    }

    const nextTitle = deriveConversationTitle(input.title, messages);
    if (nextTitle !== state.title) {
      chunks.push(serializeEvent({ type: "meta", at: now, title: nextTitle }));
    }

    let uiEntryCount = state.uiEntryCount;
    let nextUiEntryFingerprints = state.uiEntryFingerprints;
    const uiTranscript = input.uiTranscript;
    if (uiTranscript !== undefined) {
      const prefixHolds = uiPrefixHolds(uiTranscript, state.uiEntryFingerprints);
      if (!prefixHolds) {
        chunks.push(serializeEvent({ type: "ui-transcript", at: now, entries: uiTranscript }));
      } else if (uiTranscript.length > state.uiEntryCount) {
        chunks.push(
          serializeEvent({
            type: "ui-append",
            at: now,
            entries: uiTranscript.slice(state.uiEntryCount),
          }),
        );
      }
      uiEntryCount = uiTranscript.length;
      nextUiEntryFingerprints = uiTranscript.map(uiEntryFingerprint);
    }

    if (chunks.length > 0) {
      yield* fs
        .writeFileString(logPath, chunks.join(""), { flag: "a", mode: stateFileMode() })
        .pipe(Effect.mapError(toError));
    }

    const identity = yield* statLogFile(fs, logPath);
    if (identity !== null) {
      rememberAppendState(logPath, {
        identity,
        state: {
          messageCount: messages.length,
          lastMessageFingerprint: fingerprintAt(messages, messages.length - 1),
          title: nextTitle,
          uiEntryCount,
          uiEntryFingerprints: nextUiEntryFingerprints,
        },
      });
    }
  });
}

/**
 * Append-only session logs — the durable half of Jazz's conversation history.
 *
 * One session is one file of newline-delimited JSON events under
 * `{historyDirectory}/sessions/{sessionId}.jsonl`. A turn is recorded by
 * appending the new messages, so the cost of a save is proportional to what
 * changed rather than to the length of the session (the old whole-file rewrite
 * made a long conversation quadratic in its own transcript).
 *
 * Three properties matter more than elegance here:
 *
 * - **Crash tolerance.** A process killed mid-write leaves a partial final
 *   line. Readers drop unparseable lines instead of rejecting the file, and the
 *   next append re-terminates the record, so at most the interrupted turn is
 *   lost.
 * - **Replaceable state.** The log is the source of truth for message content;
 *   every other file in the history directory (the per-agent index, any future
 *   search index) can be deleted and rebuilt from these logs.
 * - **Monotonic history.** Nothing is ever rewritten in place. Compaction, which
 *   legitimately replaces the transcript, appends a `rewrite` marker instead:
 *   readers reset their accumulator, and the superseded lines stay on disk where
 *   search can still find them.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { getHistoryDirectory } from "@/core/utils/paths";

/** Schema version stamped on every session header, for future readers. */
export const SESSION_LOG_VERSION = 1;

const SESSIONS_DIRECTORY_NAME = "sessions";
const SESSION_LOG_EXTENSION = ".jsonl";

/**
 * A session id is `{agentId}~{conversationId}`, both segments reduced to
 * characters that are safe in a filename. `~` is a safe separator because agent
 * ids are already restricted to letters, digits, `_` and `-`
 * (see `requireValidAgentId`).
 */
const SESSION_ID_SEPARATOR = "~";
const MAX_ID_SEGMENT_CHARS = 64;
const ID_FINGERPRINT_CHARS = 8;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9_-]/g;

/** Characters of a message compared when checking whether a log still matches a transcript. */
const MESSAGE_FINGERPRINT_CHARS = 12;

/** Characters of the first user message used when a session was never given a title. */
const DERIVED_TITLE_CHARS = 48;

function fingerprint(value: string, chars: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, chars);
}

function storageSafeSegment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unknown";
  if (SAFE_ID_PATTERN.test(trimmed) && trimmed.length <= MAX_ID_SEGMENT_CHARS) return trimmed;
  // A reduced segment could collide with a different original, so the hash of the
  // original is what actually keeps two conversations in two files.
  const readable = trimmed.replace(UNSAFE_ID_CHARACTERS, "-").slice(0, MAX_ID_SEGMENT_CHARS);
  return `${readable}-${fingerprint(trimmed, ID_FINGERPRINT_CHARS)}`;
}

/** Returns the stable session id for an agent's conversation. */
export function makeSessionId(agentId: string, conversationId: string): string {
  return `${storageSafeSegment(agentId)}${SESSION_ID_SEPARATOR}${storageSafeSegment(conversationId)}`;
}

/** True when `sessionId` belongs to `agentId`. */
export function sessionIdBelongsToAgent(sessionId: string, agentId: string): boolean {
  return sessionId.startsWith(`${storageSafeSegment(agentId)}${SESSION_ID_SEPARATOR}`);
}

/** Directory holding the session logs for a history directory. */
export function getSessionsDirectory(historyDirectory?: string): string {
  return path.join(historyDirectory ?? getHistoryDirectory(), SESSIONS_DIRECTORY_NAME);
}

/** Path of one session's log file. */
export function getSessionLogPath(sessionId: string, historyDirectory?: string): string {
  return path.join(getSessionsDirectory(historyDirectory), `${sessionId}${SESSION_LOG_EXTENSION}`);
}

export interface SessionHeaderEvent {
  readonly type: "session";
  readonly version: number;
  readonly sessionId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly startedAt: string;
  readonly title?: string;
}

export interface SessionMessageEvent {
  readonly type: "message";
  readonly at: string;
  readonly message: ChatMessage;
}

export interface SessionMetaEvent {
  readonly type: "meta";
  readonly at: string;
  readonly title?: string;
  readonly endedAt?: string;
}

/** Marks everything before it as superseded — emitted when a transcript is replaced. */
export interface SessionRewriteEvent {
  readonly type: "rewrite";
  readonly at: string;
}

export type SessionEvent =
  SessionHeaderEvent | SessionMessageEvent | SessionMetaEvent | SessionRewriteEvent;

export interface SessionRecord {
  readonly sessionId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messages: ChatMessage[];
}

export interface SessionFileInfo {
  readonly sessionId: string;
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
 * A truncated final line from a killed process lands here as a JSON syntax
 * error; treating it as "no event" is what keeps one bad write from poisoning
 * the whole session.
 */
export function parseSessionEventLine(line: string): SessionEvent | null {
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
    case "session": {
      const sessionId = optionalString(parsed["sessionId"]);
      const agentId = optionalString(parsed["agentId"]);
      const conversationId = optionalString(parsed["conversationId"]);
      if (!sessionId || !agentId || !conversationId) return null;
      const title = optionalString(parsed["title"]);
      return {
        type: "session",
        version: typeof parsed["version"] === "number" ? parsed["version"] : SESSION_LOG_VERSION,
        sessionId,
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
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
        return null;
      }
      return { type: "message", at, message: message as unknown as ChatMessage };
    }
    case "meta": {
      const title = optionalString(parsed["title"]);
      const endedAt = optionalString(parsed["endedAt"]);
      if (title === undefined && endedAt === undefined) return null;
      return {
        type: "meta",
        at,
        ...(title === undefined ? {} : { title }),
        ...(endedAt === undefined ? {} : { endedAt }),
      };
    }
    case "rewrite":
      return { type: "rewrite", at };
    default:
      return null;
  }
}

/** First line of the first user message, used when a session has no title. */
export function deriveSessionTitle(
  title: string | undefined,
  messages: readonly ChatMessage[],
): string {
  const explicit = title?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const firstUserMessage = messages.find((message) => message.role === "user");
  const firstLine = firstUserMessage?.content.replace(/\s+/g, " ").trim() ?? "";
  if (firstLine.length === 0) return "untitled session";
  return firstLine.length > DERIVED_TITLE_CHARS
    ? `${firstLine.slice(0, DERIVED_TITLE_CHARS - 1).trimEnd()}…`
    : firstLine;
}

/** Folds a log's events into the session's current state. */
export function reduceSessionEvents(
  sessionId: string,
  events: readonly SessionEvent[],
): SessionRecord | null {
  let header: SessionHeaderEvent | null = null;
  let title: string | undefined;
  let endedAt: string | null = null;
  let messages: ChatMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case "session":
        header = event;
        title = event.title ?? title;
        break;
      case "message":
        messages.push(event.message);
        break;
      case "meta":
        if (event.title !== undefined) title = event.title;
        if (event.endedAt !== undefined) endedAt = event.endedAt;
        break;
      case "rewrite":
        messages = [];
        break;
    }
  }

  if (!header) return null;
  return {
    sessionId,
    agentId: header.agentId,
    conversationId: header.conversationId,
    title: deriveSessionTitle(title, messages),
    startedAt: header.startedAt,
    endedAt,
    messages,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readLogContent(
  fs: FileSystem.FileSystem,
  logPath: string,
): Effect.Effect<string | null, never> {
  return fs.readFileString(logPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/** Reads a whole session log and folds it into a record. */
export function readSession(
  sessionId: string,
  historyDirectory?: string,
): Effect.Effect<SessionRecord | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* readLogContent(fs, getSessionLogPath(sessionId, historyDirectory));
    if (content === null) return null;
    return reduceSessionEvents(sessionId, parseSessionLog(content));
  });
}

/** Parses a log body into events, skipping lines a crash left unreadable. */
export function parseSessionLog(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of content.split("\n")) {
    const event = parseSessionEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

/** Session logs newest-modified first, optionally narrowed to one agent. */
export function listSessions(
  historyDirectory?: string,
  agentId?: string,
): Effect.Effect<SessionFileInfo[], Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sessionsDirectory = getSessionsDirectory(historyDirectory);
    const names = yield* fs
      .readDirectory(sessionsDirectory)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));

    const infos: SessionFileInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(SESSION_LOG_EXTENSION)) continue;
      const sessionId = name.slice(0, -SESSION_LOG_EXTENSION.length);
      if (agentId !== undefined && !sessionIdBelongsToAgent(sessionId, agentId)) continue;

      const filePath = path.join(sessionsDirectory, name);
      const info = yield* fs.stat(filePath).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!info || info.type !== "File") continue;
      const modifiedAtMs = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      infos.push({ sessionId, filePath, modifiedAtMs });
    }

    return infos.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  });
}

/** Removes one session log. Nothing else references it, so this is the whole delete. */
export function deleteSession(
  sessionId: string,
  historyDirectory?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(getSessionLogPath(sessionId, historyDirectory))
      .pipe(Effect.catchAll(() => Effect.void));
  });
}

interface AppendState {
  readonly messageCount: number;
  readonly lastMessageFingerprint: string;
  readonly title: string;
  readonly endedAt: string | null;
}

/**
 * What this process has already appended, keyed by log path.
 *
 * Without it, appending "only the new messages" would need a full read of the
 * log on every turn, which is the cost the append-only format exists to avoid.
 * A miss (first turn after a resume, or another process holding the session)
 * costs exactly one read.
 */
const appendStates = new Map<string, AppendState>();

/** Drops the in-process append cache. Tests use it between temporary directories. */
export function resetSessionAppendCache(): void {
  appendStates.clear();
}

function messageFingerprint(message: ChatMessage): string {
  return `${message.role}:${message.content.length}:${fingerprint(message.content, MESSAGE_FINGERPRINT_CHARS)}`;
}

function fingerprintAt(messages: readonly ChatMessage[], index: number): string {
  const message = messages[index];
  return message ? messageFingerprint(message) : "";
}

function serializeEvent(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

interface LoadedAppendState {
  /** Null when the file is absent, empty, or holds no readable header. */
  readonly state: AppendState | null;
  readonly needsLeadingNewline: boolean;
}

function loadAppendState(
  fs: FileSystem.FileSystem,
  logPath: string,
  sessionId: string,
): Effect.Effect<LoadedAppendState, never> {
  return Effect.gen(function* () {
    const content = yield* readLogContent(fs, logPath);
    if (content === null) return { state: null, needsLeadingNewline: false };

    // A crash can leave the last line half-written; the next append has to start
    // on a fresh line or it would corrupt an otherwise readable record too.
    const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
    const record = reduceSessionEvents(sessionId, parseSessionLog(content));
    if (!record) return { state: null, needsLeadingNewline };

    return {
      state: {
        messageCount: record.messages.length,
        lastMessageFingerprint: fingerprintAt(record.messages, record.messages.length - 1),
        title: record.title,
        endedAt: record.endedAt,
      },
      needsLeadingNewline,
    };
  });
}

export interface SessionTranscriptInput {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messages: readonly ChatMessage[];
}

/**
 * Records the current state of a conversation, appending only what is new.
 *
 * Callers hand over the whole transcript (that is the shape the chat loop
 * already has); this compares it against what the log holds and appends the
 * tail. When the prefix no longer matches — compaction replaced the transcript —
 * a `rewrite` marker and the full new transcript are appended instead.
 *
 * @returns the session id the transcript was written to.
 */
export function recordSessionTranscript(
  input: SessionTranscriptInput,
  historyDirectory?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sessionId = makeSessionId(input.agentId, input.conversationId);
    const logPath = getSessionLogPath(sessionId, historyDirectory);

    yield* fs
      .makeDirectory(path.dirname(logPath), { recursive: true })
      .pipe(Effect.mapError(toError));

    const cached = appendStates.get(logPath);
    const loaded = cached
      ? { state: cached, needsLeadingNewline: false }
      : yield* loadAppendState(fs, logPath, sessionId);

    let state = loaded.state;
    const chunks: string[] = [];
    if (loaded.needsLeadingNewline) chunks.push("\n");

    if (!state) {
      const title = input.title.trim();
      chunks.push(
        serializeEvent({
          type: "session",
          version: SESSION_LOG_VERSION,
          sessionId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          startedAt: input.startedAt,
          ...(title.length === 0 ? {} : { title }),
        }),
      );
      state = {
        messageCount: 0,
        lastMessageFingerprint: "",
        title: deriveSessionTitle(title, input.messages),
        endedAt: null,
      };
    }

    const prefixHolds =
      input.messages.length >= state.messageCount &&
      fingerprintAt(input.messages, state.messageCount - 1) === state.lastMessageFingerprint;

    const now = new Date().toISOString();
    let firstNewMessage = state.messageCount;
    if (!prefixHolds) {
      chunks.push(serializeEvent({ type: "rewrite", at: now }));
      firstNewMessage = 0;
    }

    for (let index = firstNewMessage; index < input.messages.length; index++) {
      const message = input.messages[index];
      if (!message) continue;
      chunks.push(serializeEvent({ type: "message", at: now, message }));
    }

    const nextTitle = deriveSessionTitle(input.title, input.messages);
    const titleChanged = nextTitle !== state.title;
    const endedAtChanged = input.endedAt !== null && input.endedAt !== state.endedAt;
    if (titleChanged || endedAtChanged) {
      chunks.push(
        serializeEvent({
          type: "meta",
          at: now,
          ...(titleChanged ? { title: nextTitle } : {}),
          ...(endedAtChanged && input.endedAt !== null ? { endedAt: input.endedAt } : {}),
        }),
      );
    }

    if (chunks.length > 0) {
      yield* fs
        .writeFileString(logPath, chunks.join(""), { flag: "a" })
        .pipe(Effect.mapError(toError));
    }

    appendStates.set(logPath, {
      messageCount: input.messages.length,
      lastMessageFingerprint: fingerprintAt(input.messages, input.messages.length - 1),
      title: nextTitle,
      endedAt: endedAtChanged ? input.endedAt : state.endedAt,
    });

    return sessionId;
  });
}

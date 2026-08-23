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
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { getHistoryDirectory } from "@/core/utils/paths";

/**
 * Schema version stamped on every header.
 *
 * 2 dropped the derived `sessionId` field, stopped recording system messages, and moved
 * from one flat directory of `{agent}~{conversation}.jsonl` to a directory per agent.
 */
export const CONVERSATION_LOG_VERSION = 2;

const CONVERSATIONS_DIRECTORY_NAME = "conversations";
const CONVERSATION_LOG_EXTENSION = ".jsonl";

const MAX_ID_SEGMENT_CHARS = 64;
const ID_FINGERPRINT_CHARS = 8;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9_-]/g;

/** Characters of a message compared when checking whether a log still matches a transcript. */
const MESSAGE_FINGERPRINT_CHARS = 12;

/** Characters of the first user message used when a conversation was never given a title. */
const DERIVED_TITLE_CHARS = 48;

function fingerprint(value: string, chars: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, chars);
}

/**
 * Reduce an id to something safe in a path.
 *
 * Lossy on purpose for ids that are not already path-safe: the readable part is truncated
 * and a hash of the original appended, so two different ids can never collide on one file.
 * Because it is lossy, a path is never parsed back into ids — the header carries them.
 */
function storageSafeSegment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unknown";
  if (SAFE_ID_PATTERN.test(trimmed) && trimmed.length <= MAX_ID_SEGMENT_CHARS) return trimmed;
  const readable = trimmed.replace(UNSAFE_ID_CHARACTERS, "-").slice(0, MAX_ID_SEGMENT_CHARS);
  return `${readable}-${fingerprint(trimmed, ID_FINGERPRINT_CHARS)}`;
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
  readonly endedAt?: string;
}

/** Compaction replaced the transcript; readers reset and keep only what follows. */
export interface ConversationLogRewrite {
  readonly type: "rewrite";
  readonly at: string;
}

export type ConversationLogEvent =
  ConversationLogHeader | ConversationLogMessage | ConversationLogMeta | ConversationLogRewrite;

/** A conversation and everything said in it. */
export interface Conversation {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messages: ChatMessage[];
}

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
  readonly endedAt: string | null;
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
 */
export function parseConversationLogLine(line: string): ConversationLogEvent | null {
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

/** First line of the first user message, used when a conversation has no title. */
export function deriveConversationTitle(
  title: string | undefined,
  messages: readonly ChatMessage[],
): string {
  const explicit = title?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const firstUserMessage = messages.find((message) => message.role === "user");
  const firstLine = firstUserMessage?.content.replace(/\s+/g, " ").trim() ?? "";
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
  let endedAt: string | null = null;
  let messages: ChatMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case "conversation":
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
    agentId: header.agentId,
    conversationId: header.conversationId,
    title: deriveConversationTitle(title, messages),
    startedAt: header.startedAt,
    endedAt,
    messages,
  };
}

export function summarize(conversation: Conversation): ConversationSummary {
  return {
    agentId: conversation.agentId,
    conversationId: conversation.conversationId,
    title: conversation.title,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    messageCount: conversation.messages.length,
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

/** Parses a log body into events, skipping lines a crash left unreadable. */
export function parseConversationLog(content: string): ConversationLogEvent[] {
  const events: ConversationLogEvent[] = [];
  for (const line of content.split("\n")) {
    const event = parseConversationLogLine(line);
    if (event) events.push(event);
  }
  return events;
}

/** Reads a whole conversation log and folds it into a conversation. */
export function readConversationLog(
  agentId: string,
  conversationId: string,
  historyDirectory?: string,
): Effect.Effect<Conversation | null, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* readLogContent(
      fs,
      conversationLogPath(agentId, conversationId, historyDirectory),
    );
    if (content === null) return null;
    return reduceConversationLog(parseConversationLog(content));
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

      const content = yield* readLogContent(fs, filePath);
      if (content === null) continue;
      const header = parseConversationLogLine(content.split("\n", 1)[0] ?? "");
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
    yield* fs.remove(logPath).pipe(Effect.catchAll(() => Effect.void));
    // The append cache says "this file already holds N messages and a header". Leaving it
    // behind a delete would make the next append skip both, writing a headerless log that
    // reduces to nothing.
    appendStates.delete(logPath);
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
 * Without it, appending "only the new messages" would need a full read of the log on every
 * turn, which is the cost the append-only format exists to avoid. A miss (first turn after
 * a resume, or another process holding the conversation) costs exactly one read.
 */
const appendStates = new Map<string, AppendState>();

/** Drops the in-process append cache. Tests use it between temporary directories. */
export function resetConversationLogAppendCache(): void {
  appendStates.clear();
}

function messageFingerprint(message: ChatMessage): string {
  return `${message.role}:${message.content.length}:${fingerprint(message.content, MESSAGE_FINGERPRINT_CHARS)}`;
}

function fingerprintAt(messages: readonly ChatMessage[], index: number): string {
  const message = messages[index];
  return message ? messageFingerprint(message) : "";
}

function serializeEvent(event: ConversationLogEvent): string {
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
): Effect.Effect<LoadedAppendState, never> {
  return Effect.gen(function* () {
    const content = yield* readLogContent(fs, logPath);
    if (content === null) return { state: null, needsLeadingNewline: false };

    // A crash can leave the last line half-written; the next append has to start on a
    // fresh line or it would corrupt an otherwise readable record too.
    const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
    const conversation = reduceConversationLog(parseConversationLog(content));
    if (!conversation) return { state: null, needsLeadingNewline };

    return {
      state: {
        messageCount: conversation.messages.length,
        lastMessageFingerprint: fingerprintAt(
          conversation.messages,
          conversation.messages.length - 1,
        ),
        title: conversation.title,
        endedAt: conversation.endedAt,
      },
      needsLeadingNewline,
    };
  });
}

export interface ConversationTranscriptInput {
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
 * Callers hand over the whole transcript — that is the shape the chat loop already has —
 * and this compares it against the log and appends the tail. When the prefix no longer
 * matches, because compaction replaced the transcript, a `rewrite` marker and the full new
 * transcript are appended instead.
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

    yield* fs
      .makeDirectory(path.dirname(logPath), { recursive: true })
      .pipe(Effect.mapError(toError));

    const cached = appendStates.get(logPath);
    const loaded = cached
      ? { state: cached, needsLeadingNewline: false }
      : yield* loadAppendState(fs, logPath);

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
        endedAt: null,
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
      messageCount: messages.length,
      lastMessageFingerprint: fingerprintAt(messages, messages.length - 1),
      title: nextTitle,
      endedAt: endedAtChanged ? input.endedAt : state.endedAt,
    });
  });
}

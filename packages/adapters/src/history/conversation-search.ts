/**
 * Cross-session search over the append-only session logs.
 *
 * **Scan, not index.** A SQLite FTS table would be faster per query, but it buys
 * that speed with a second writable artefact on the hot path: every appended
 * turn would have to update it, a torn write leaves the index disagreeing with
 * the log, and the recovery story is "detect the disagreement and rebuild"
 * — code that only ever runs after something has already gone wrong. The
 * corpus does not justify it: history is capped at
 * `MAX_CONVERSATION_HISTORY_PER_AGENT` sessions per agent, a busy session is
 * tens of kilobytes, and the search overlay only ever needs the first screenful
 * of hits. So this scans, in the order the results are wanted (current session,
 * then most recently touched), and stops as soon as it has `limit` hits — which
 * means the common query touches one or two files. The cost is bounded rather
 * than cheap, and the caps below are the honest statement of that bound:
 * at most `MAX_SESSIONS_SCANNED` files, at most `MAX_BYTES_PER_SESSION` of each,
 * preferring a session's head (for its title) and its tail (its recent turns).
 *
 * Deliberately plain async rather than Effect: the shape below is fixed by the
 * interface that renders it, it is called on every keystroke of the search
 * overlay, and it reads with byte offsets that `FileSystem` would only make
 * more roundabout.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getHistoryDirectory } from "@jazz/core/utils/paths";
import {
  deriveConversationTitle,
  conversationLogPath,
  getConversationLogsDirectory,
  parseConversationLogLine,
  type ConversationLogEvent,
} from "./conversation-log";

/** Newest sessions considered for a single query. */
const MAX_SESSIONS_SCANNED = 40;
/** Bytes read from any one session log. */
const MAX_BYTES_PER_SESSION = 256 * 1024;
/** Bytes read from the start of an oversized log, enough to reach its header event. */
const HEAD_BYTES = 4 * 1024;
const DEFAULT_LIMIT = 50;

/** Characters of context kept around a match when a line is too long to return whole. */
const MAX_HIT_LINE_CHARS = 200;
const MATCH_LEAD_CHARS = 24;

const CONVERSATION_LOG_EXTENSION = ".jsonl";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Weeks are readable up to this point; past it, months read better. */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * One matching line, ready to render.
 *
 * `matchStart` and `matchLength` are **code-point** indices into `line` as
 * returned — the renderer marks the match by slicing `[...line]`, so a UTF-16
 * index would drift by one for every astral character earlier in the line.
 * `line` is already whitespace-collapsed and trimmed for the same reason: the
 * renderer collapses whitespace before indexing.
 */
export interface SearchHit {
  readonly agentId: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly when: string;
  readonly line: string;
  readonly matchStart: number;
  readonly matchLength: number;
  readonly current: boolean;
}

export interface SearchOptions {
  readonly scope: "conversation" | "all";
  /**
   * The conversation being viewed, hoisted to the front of the results and required by
   * `scope: "conversation"`.
   *
   * No caller supplies it yet, which makes the interface's scope toggle inert — narrowing
   * to one conversation currently yields nothing at all. Fixing that means giving the
   * fullscreen bridge the identity of the conversation it is displaying, which it does not
   * currently hold.
   */
  readonly current?: { readonly agentId: string; readonly conversationId: string };
  readonly limit?: number;
  /** History directory override. Defaults to the user's history directory. */
  readonly dir?: string;
  /** Reference instant for the relative `when` label. Defaults to now. */
  readonly now?: number;
}

/** Short relative time: "now", "5m ago", "2d ago", "1w ago". */
export function formatRelativeWhen(instantMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - instantMs);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${String(Math.floor(elapsed / MINUTE_MS))}m ago`;
  if (elapsed < DAY_MS) return `${String(Math.floor(elapsed / HOUR_MS))}h ago`;
  if (elapsed < WEEK_MS) return `${String(Math.floor(elapsed / DAY_MS))}d ago`;
  if (elapsed < MONTH_MS) return `${String(Math.floor(elapsed / WEEK_MS))}w ago`;
  if (elapsed < YEAR_MS) return `${String(Math.floor(elapsed / MONTH_MS))}mo ago`;
  return `${String(Math.floor(elapsed / YEAR_MS))}y ago`;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Index of `needle` in `haystack`, both as code-point arrays, `needle` already
 * lowercased. Comparing per code point keeps the returned index aligned with the
 * original text even where lowercasing changes a character's length.
 */
function findCodePointMatch(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const lastStart = haystack.length - needle.length;
  for (let start = 0; start <= lastStart; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset]?.toLowerCase() !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

interface RenderableLine {
  readonly line: string;
  readonly matchStart: number;
  readonly matchLength: number;
}

/**
 * Trims a long line to something renderable, sliding the window so the match
 * stays inside it and shifting the indices by the same amount.
 */
function toRenderableLine(
  chars: readonly string[],
  matchStart: number,
  matchLength: number,
): RenderableLine {
  if (chars.length <= MAX_HIT_LINE_CHARS) {
    return { line: chars.join(""), matchStart, matchLength };
  }

  const windowStart = Math.min(
    Math.max(0, matchStart - MATCH_LEAD_CHARS),
    chars.length - MAX_HIT_LINE_CHARS,
  );
  const visible = chars.slice(windowStart, windowStart + MAX_HIT_LINE_CHARS);
  const relativeStart = matchStart - windowStart;
  return {
    line: visible.join(""),
    matchStart: relativeStart,
    matchLength: Math.min(matchLength, visible.length - relativeStart),
  };
}

interface ScannedConversation {
  readonly filePath: string;
  readonly modifiedAtMs: number;
}

/**
 * Every conversation log under the history root, newest first.
 *
 * Logs live one directory per agent, so this is a two-level walk. Identity comes from each
 * file's header when it is read, never from its path: path segments are lossy for ids that
 * are not already filename-safe.
 */
async function listCandidates(
  root: string,
  currentPath: string | undefined,
): Promise<ScannedConversation[]> {
  let agentDirectories: string[];
  try {
    agentDirectories = await fsp.readdir(root);
  } catch {
    return [];
  }

  const conversations: ScannedConversation[] = [];
  for (const agentDirectory of agentDirectories) {
    const directory = path.join(root, agentDirectory);
    let names: string[];
    try {
      if (!(await fsp.stat(directory)).isDirectory()) continue;
      names = await fsp.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(CONVERSATION_LOG_EXTENSION)) continue;
      const filePath = path.join(directory, name);
      try {
        const info = await fsp.stat(filePath);
        if (!info.isFile()) continue;
        conversations.push({ filePath, modifiedAtMs: info.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  conversations.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const currentIndex = conversations.findIndex(
    (conversation) => conversation.filePath === currentPath,
  );
  if (currentIndex > 0) {
    const [current] = conversations.splice(currentIndex, 1);
    if (current) conversations.unshift(current);
  }
  return conversations.slice(0, MAX_SESSIONS_SCANNED);
}

async function statConversation(filePath: string): Promise<ScannedConversation | null> {
  try {
    const info = await fsp.stat(filePath);
    if (!info.isFile()) return null;
    return { filePath, modifiedAtMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Reads a session log, capped. Oversized logs give up their middle: the head
 * carries the header event (title, agent), the tail carries the recent turns.
 * Lines cut in half by either boundary fail to parse and are dropped, the same
 * way a crash-truncated line is.
 */
async function readCappedLog(filePath: string): Promise<string> {
  let size: number;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return "";
  }

  if (size <= MAX_BYTES_PER_SESSION) {
    try {
      return await fsp.readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  const handle = await fsp.open(filePath, "r").catch(() => null);
  if (!handle) return "";
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    const tailBytes = MAX_BYTES_PER_SESSION - HEAD_BYTES;
    const tail = Buffer.alloc(tailBytes);
    await handle.read(tail, 0, tailBytes, size - tailBytes);
    return `${head.toString("utf-8")}\n${tail.toString("utf-8")}`;
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface ConversationContent {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title: string;
  /** Message text in log order. */
  readonly texts: string[];
}

function readConversationContent(content: string): ConversationContent | null {
  const events: ConversationLogEvent[] = [];
  for (const line of content.split("\n")) {
    const event = parseConversationLogLine(line);
    if (event) events.push(event);
  }

  let header: { agentId: string; conversationId: string } | undefined;
  let title: string | undefined;
  const texts: string[] = [];
  const messages = [];
  for (const event of events) {
    if (event.type === "conversation") {
      header = { agentId: event.agentId, conversationId: event.conversationId };
      title = event.title ?? title;
    } else if (event.type === "meta" && event.title !== undefined) title = event.title;
    else if (event.type === "message") {
      messages.push(event.message);
      texts.push(event.message.content);
    }
  }

  // A log whose header did not survive the read cap cannot be attributed to a conversation,
  // and a hit nobody can open is worse than no hit.
  if (!header) return null;
  return { ...header, title: deriveConversationTitle(title, messages), texts };
}

function collectHits(
  conversation: ScannedConversation,
  content: ConversationContent,
  needle: readonly string[],
  lowercaseQuery: string,
  options: { readonly nowMs: number; readonly currentPath?: string; readonly budget: number },
): SearchHit[] {
  const hits: SearchHit[] = [];
  const when = formatRelativeWhen(conversation.modifiedAtMs, options.nowMs);
  const current = conversation.filePath === options.currentPath;

  // Newest turn first: in a transcript the most recent mention is the one the
  // reader is usually looking for.
  for (let index = content.texts.length - 1; index >= 0; index--) {
    const text = content.texts[index];
    if (text === undefined) continue;
    for (const rawLine of text.split("\n")) {
      if (hits.length >= options.budget) return hits;
      const line = normalizeLine(rawLine);
      if (line.length === 0) continue;
      // Cheap reject before the per-code-point walk.
      if (!line.toLowerCase().includes(lowercaseQuery)) continue;

      const chars = [...line];
      const matchStart = findCodePointMatch(chars, needle);
      if (matchStart < 0) continue;

      const renderable = toRenderableLine(chars, matchStart, needle.length);
      hits.push({
        agentId: content.agentId,
        conversationId: content.conversationId,
        conversationTitle: content.title,
        when,
        line: renderable.line,
        matchStart: renderable.matchStart,
        matchLength: renderable.matchLength,
        current,
      });
    }
  }
  return hits;
}

/**
 * Searches conversation transcripts for `query`, case-insensitively.
 *
 * Hits from `current` come first, then conversations by how recently they were written.
 * Scanning stops at `limit`, so an early match costs one file read.
 */
export async function search(query: string, options: SearchOptions): Promise<SearchHit[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return [];

  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  if (limit === 0) return [];

  const historyDirectory = options.dir ?? getHistoryDirectory();
  const root = getConversationLogsDirectory(historyDirectory);
  // Computed forwards from the ids rather than matched against a parsed path, because
  // `storageSafeSegment` is lossy and a path cannot be turned back into ids.
  const currentPath =
    options.current === undefined
      ? undefined
      : conversationLogPath(
          options.current.agentId,
          options.current.conversationId,
          historyDirectory,
        );

  const candidates =
    options.scope === "conversation"
      ? currentPath === undefined
        ? []
        : [await statConversation(currentPath)].filter(
            (conversation): conversation is ScannedConversation => conversation !== null,
          )
      : await listCandidates(root, currentPath);

  const nowMs = options.now ?? Date.now();
  const needle = [...trimmedQuery].map((character) => character.toLowerCase());
  const lowercaseQuery = trimmedQuery.toLowerCase();

  const hits: SearchHit[] = [];
  for (const conversation of candidates) {
    if (hits.length >= limit) break;
    const content = readConversationContent(await readCappedLog(conversation.filePath));
    if (!content) continue;
    hits.push(
      ...collectHits(conversation, content, needle, lowercaseQuery, {
        nowMs,
        ...(currentPath === undefined ? {} : { currentPath }),
        budget: limit - hits.length,
      }),
    );
  }

  return hits.slice(0, limit);
}

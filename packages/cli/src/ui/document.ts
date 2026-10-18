/**
 * The authoritative conversation document and renderer projections. Document
 * updates retain source identity across streaming and settlement. Classic Ink
 * promotion is derived here; it never truncates or rewrites source entries.
 */
import { isTerminalReport } from "@jazz/core/interfaces/terminal";
import type {
  PresentationContent,
  PresentationDocument,
  PresentationEntry,
} from "@jazz/core/types/presentation-content";
import type { OutputEntry, OutputEntryWithId } from "./types";
import { stripAnsiCodes } from "../utils/string-utils";
import type { StreamKind } from "./adapters/terminal-output-adapter";

export function contentFromOutput(entry: OutputEntry): PresentationContent {
  if (typeof entry.message !== "string") {
    if (isTerminalReport(entry.message)) return { kind: "report", report: entry.message };
    return entry.message;
  }
  const text = stripAnsiCodes(entry.message);
  if (entry.type === "user") return { kind: "user", text };
  if (entry.type === "streamContent") return { kind: "agent", markdown: text };
  return { kind: "notice", text, tone: entry.type };
}

export function outputFromEntry(entry: PresentationEntry): OutputEntryWithId {
  const content = entry.content;
  const type =
    content.kind === "user"
      ? "user"
      : content.kind === "agent" || content.kind === "reasoning"
        ? "streamContent"
        : content.kind === "notice"
          ? content.tone
          : "log";
  return {
    id: entry.id,
    type: content.kind === "turn-receipt" ? "debug" : type,
    message:
      content.kind === "user" || (content.kind === "notice" && content.audience === undefined)
        ? content.text
        : content,
    timestamp: new Date(entry.timestamp),
  };
}

/**
 * The presentation document split at the start of the current turn. Earlier turns are one array
 * shared by every revision until the next user message; a streamed delta, a printed entry or a
 * reasoning update copies only the current turn. Renderer projections are turn-local (reasoning
 * and plan receipts fold within a turn), so they cache earlier turns by array identity and
 * re-project the current turn alone. `entries` joins both on first read, once per revision, for
 * durable readers.
 */
export class TranscriptDocument implements PresentationDocument {
  readonly id: string;
  readonly revision: number;
  /** Every entry before the current turn's user message; never ends inside a turn. */
  readonly earlierTurns: readonly PresentationEntry[];
  /** From the last user message on, or every entry while there is none. */
  readonly currentTurn: readonly PresentationEntry[];
  readonly streamingId?: string;
  private joined: readonly PresentationEntry[] | undefined;

  constructor(
    id: string,
    revision: number,
    earlierTurns: readonly PresentationEntry[],
    currentTurn: readonly PresentationEntry[],
    streamingId?: string,
  ) {
    this.id = id;
    this.revision = revision;
    this.earlierTurns = earlierTurns;
    this.currentTurn = currentTurn;
    if (streamingId !== undefined) {
      this.streamingId = streamingId;
    }
  }

  get entries(): readonly PresentationEntry[] {
    if (this.joined === undefined) {
      this.joined =
        this.earlierTurns.length === 0
          ? this.currentTurn
          : this.currentTurn.length === 0
            ? this.earlierTurns
            : [...this.earlierTurns, ...this.currentTurn];
    }
    return this.joined;
  }

  /** Serializes as the plain document it stands for. */
  toJSON(): PresentationDocument {
    return {
      id: this.id,
      revision: this.revision,
      entries: this.entries,
      ...(this.streamingId === undefined ? {} : { streamingId: this.streamingId }),
    };
  }
}

function replaceAt(
  entries: readonly PresentationEntry[],
  index: number,
  entry: PresentationEntry,
): readonly PresentationEntry[] {
  const replaced = entries.slice();
  replaced[index] = entry;
  return replaced;
}

function lastUserIndex(entries: readonly PresentationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.content.kind === "user") {
      return index;
    }
  }
  return -1;
}

function documentWithTurn(
  id: string,
  revision: number,
  earlierTurns: readonly PresentationEntry[],
  entries: readonly PresentationEntry[],
  streamingId: string | undefined,
): TranscriptDocument {
  const boundary = lastUserIndex(entries);
  if (boundary <= 0) {
    return new TranscriptDocument(id, revision, earlierTurns, entries, streamingId);
  }
  return new TranscriptDocument(
    id,
    revision,
    [...earlierTurns, ...entries.slice(0, boundary)],
    entries.slice(boundary),
    streamingId,
  );
}

export function createDocument(
  id: string,
  revision: number,
  entries: readonly PresentationEntry[],
  streamingId?: string,
): TranscriptDocument {
  return documentWithTurn(id, revision, [], entries, streamingId);
}

/** Accept any document shape; the store builds only TranscriptDocuments. */
export function transcriptDocument(document: PresentationDocument): TranscriptDocument {
  if (document instanceof TranscriptDocument) {
    return document;
  }
  return createDocument(document.id, document.revision, document.entries, document.streamingId);
}

function withCurrentTurn(
  document: TranscriptDocument,
  currentTurn: readonly PresentationEntry[],
  streamingId: string | undefined,
): TranscriptDocument {
  return documentWithTurn(
    document.id,
    document.revision + 1,
    document.earlierTurns,
    currentTurn,
    streamingId,
  );
}

export function lastDocumentEntry(document: PresentationDocument): PresentationEntry | undefined {
  const source = transcriptDocument(document);
  return source.currentTurn.at(-1) ?? source.earlierTurns.at(-1);
}

/** The entry with this id, searching the current turn (where live entries are) first. */
export function findDocumentEntry(
  document: PresentationDocument,
  id: string,
): PresentationEntry | undefined {
  const source = transcriptDocument(document);
  return (
    source.currentTurn.find((entry) => entry.id === id) ??
    source.earlierTurns.find((entry) => entry.id === id)
  );
}

/** Replace the entry with the same id; one in an earlier turn costs a copy of earlier turns. */
export function replaceDocumentEntry(
  document: PresentationDocument,
  entry: PresentationEntry,
): PresentationDocument {
  const source = transcriptDocument(document);
  const turnIndex = source.currentTurn.findIndex((candidate) => candidate.id === entry.id);
  if (turnIndex >= 0) {
    return new TranscriptDocument(
      source.id,
      source.revision + 1,
      source.earlierTurns,
      replaceAt(source.currentTurn, turnIndex, entry),
      source.streamingId,
    );
  }
  const earlierIndex = source.earlierTurns.findIndex((candidate) => candidate.id === entry.id);
  if (earlierIndex < 0) {
    return document;
  }
  return new TranscriptDocument(
    source.id,
    source.revision + 1,
    replaceAt(source.earlierTurns, earlierIndex, entry),
    source.currentTurn,
    source.streamingId,
  );
}

export function appendDocumentEntries(
  document: PresentationDocument,
  entries: readonly PresentationEntry[],
): PresentationDocument {
  if (entries.length === 0) return document;
  const source = transcriptDocument(document);
  return withCurrentTurn(source, [...source.currentTurn, ...entries], source.streamingId);
}

export function appendDocumentStream(
  document: PresentationDocument,
  kind: StreamKind,
  delta: string,
  nextId: string,
  timestamp: string,
): PresentationDocument {
  if (delta.length === 0) return document;
  const source = transcriptDocument(document);
  const last = source.currentTurn.at(-1);
  const matching =
    last !== undefined &&
    last.id === source.streamingId &&
    (kind === "response" ? last.content.kind === "agent" : last.content.kind === "reasoning");
  if (matching && last !== undefined) {
    const content = last.content;
    const nextContent: PresentationContent =
      content.kind === "agent"
        ? { ...content, markdown: content.markdown + delta }
        : content.kind === "reasoning"
          ? { ...content, text: content.text + delta }
          : content;
    return new TranscriptDocument(
      source.id,
      source.revision + 1,
      source.earlierTurns,
      replaceAt(source.currentTurn, source.currentTurn.length - 1, {
        ...last,
        content: nextContent,
      }),
      source.streamingId,
    );
  }
  const content: PresentationContent =
    kind === "response"
      ? { kind: "agent", markdown: delta }
      : { kind: "reasoning", text: delta, label: "Reasoning" };
  return withCurrentTurn(
    source,
    [...source.currentTurn, { id: nextId, content, timestamp }],
    nextId,
  );
}

/**
 * Add an entry while an answer streams, without ending that answer: it goes just before the
 * answer, which stays last and keeps taking deltas. Without an answer streaming it is appended.
 */
export function insertBeforeDocumentStream(
  document: PresentationDocument,
  entry: PresentationEntry,
): PresentationDocument {
  const source = transcriptDocument(document);
  const last = source.currentTurn.at(-1);
  if (last === undefined || last.id !== source.streamingId || last.content.kind !== "agent") {
    return appendDocumentEntries(settleDocumentStream(source), [entry]);
  }
  return withCurrentTurn(
    source,
    [...source.currentTurn.slice(0, -1), entry, last],
    source.streamingId,
  );
}

export function settleDocumentStream(document: PresentationDocument): PresentationDocument {
  if (document.streamingId === undefined) return document;
  const source = transcriptDocument(document);
  return new TranscriptDocument(
    source.id,
    source.revision + 1,
    source.earlierTurns,
    source.currentTurn,
  );
}

/** Transient renderer state; accepted source text is never paced or collapsed. */
export interface DocumentViewOptions {
  readonly expandedReasoningIds?: ReadonlySet<string>;
  readonly liveReasoningIds?: ReadonlySet<string>;
  readonly hiddenReasoningIds?: ReadonlySet<string>;
  readonly streamReveal?: { readonly id: string; readonly length: number } | null;
}

/** Whether `next` holds the same entry objects as `previous`, then possibly more. */
export function extendsEntries(
  previous: readonly PresentationEntry[],
  next: readonly PresentationEntry[],
): boolean {
  if (next.length < previous.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

/** Whether any of `ids` is in one snapshot of a view set and not the other. */
export function membershipChanged(
  ids: ReadonlySet<string>,
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string> | undefined,
): boolean {
  if (previous === next) {
    return false;
  }
  for (const id of previous ?? []) {
    if (ids.has(id) && next?.has(id) !== true) {
      return true;
    }
  }
  for (const id of next ?? []) {
    if (ids.has(id) && previous?.has(id) !== true) {
      return true;
    }
  }
  return false;
}

/**
 * Projects earlier turns once and extends the result as turns end. They are re-projected whole
 * only when an entry in them was replaced, or a view set changed membership for one of their ids.
 */
export function createEarlierTurnsProjection<Item, View extends object>(
  project: (entries: readonly PresentationEntry[], view: View, start: number) => readonly Item[],
  viewSets: (view: View) => readonly (ReadonlySet<string> | undefined)[],
): (earlierTurns: readonly PresentationEntry[], view: View) => readonly Item[] {
  let source: readonly PresentationEntry[] = [];
  let ids = new Set<string>();
  let items: readonly Item[] = [];
  let sets: readonly (ReadonlySet<string> | undefined)[] = [];
  return (earlierTurns, view) => {
    const nextSets = viewSets(view);
    const viewChanged = nextSets.some((set, index) => membershipChanged(ids, sets[index], set));
    sets = nextSets;
    if (earlierTurns === source && !viewChanged) {
      return items;
    }
    if (!viewChanged && extendsEntries(source, earlierTurns)) {
      const added = earlierTurns.slice(source.length);
      items = [...items, ...project(added, view, items.length)];
      for (const entry of added) {
        ids.add(entry.id);
      }
    } else {
      items = project(earlierTurns, view, 0);
      ids = new Set(earlierTurns.map((entry) => entry.id));
    }
    source = earlierTurns;
    return items;
  };
}

/** Fold settled reasoning within a user turn without changing durable source facts. */
export function projectDocumentEntries(
  document: PresentationDocument,
  options: DocumentViewOptions = {},
): readonly PresentationEntry[] {
  return projectEntries(document.entries, options);
}

/**
 * Fold settled reasoning within each user turn of `entries`. Folding never crosses a user
 * entry, so projecting earlier turns and the current turn apart and joining them is the same as
 * projecting the whole document.
 */
export function projectEntries(
  entries: readonly PresentationEntry[],
  options: DocumentViewOptions = {},
): readonly PresentationEntry[] {
  const projected: Array<PresentationEntry | undefined> = [];
  let thoughtIndex: number | undefined;
  let folded = false;
  for (const original of entries) {
    let entry = original;
    const content = entry.content;
    if (content.kind === "user") thoughtIndex = undefined;
    if (
      content.kind === "reasoning" &&
      (options.hiddenReasoningIds?.has(entry.id) ||
        (content.text.length === 0 &&
          content.durationMs === undefined &&
          !options.liveReasoningIds?.has(entry.id)))
    )
      continue;
    if (
      content.kind === "agent" &&
      options.streamReveal?.id === entry.id &&
      options.streamReveal.length < content.markdown.length
    ) {
      entry = {
        ...entry,
        content: { ...content, markdown: content.markdown.slice(0, options.streamReveal.length) },
      };
    }
    if (
      content.kind === "reasoning" &&
      content.durationMs !== undefined &&
      !options.expandedReasoningIds?.has(entry.id) &&
      !options.liveReasoningIds?.has(entry.id)
    ) {
      const previous = thoughtIndex === undefined ? undefined : projected[thoughtIndex];
      if (previous?.content.kind === "reasoning" && thoughtIndex !== undefined) {
        projected[thoughtIndex] = undefined;
        folded = true;
        const prior = previous.content;
        entry = {
          ...entry,
          id: previous.id,
          content: {
            ...content,
            text: [prior.text, content.text].filter(Boolean).join("\n\n"),
            durationMs: (prior.durationMs ?? 0) + content.durationMs,
            steps: (prior.steps ?? 1) + (content.steps ?? 1),
            ...(prior.tokens === undefined && content.tokens === undefined
              ? {}
              : { tokens: (prior.tokens ?? 0) + (content.tokens ?? 0) }),
          },
        };
      }
      thoughtIndex = projected.length;
    }
    projected.push(entry);
  }
  if (!folded) {
    return projected as PresentationEntry[];
  }
  return projected.filter((entry): entry is PresentationEntry => entry !== undefined);
}

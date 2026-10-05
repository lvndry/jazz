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

export function appendDocumentEntries(
  document: PresentationDocument,
  entries: readonly PresentationEntry[],
): PresentationDocument {
  if (entries.length === 0) return document;
  return {
    ...document,
    revision: document.revision + 1,
    entries: [...document.entries, ...entries],
  };
}

export function appendDocumentStream(
  document: PresentationDocument,
  kind: StreamKind,
  delta: string,
  nextId: string,
  timestamp: string,
): PresentationDocument {
  if (delta.length === 0) return document;
  const last = document.entries.at(-1);
  const matching =
    last !== undefined &&
    last.id === document.streamingId &&
    (kind === "response" ? last.content.kind === "agent" : last.content.kind === "reasoning");
  if (matching && last !== undefined) {
    const content = last.content;
    const nextContent: PresentationContent =
      content.kind === "agent"
        ? { ...content, markdown: content.markdown + delta }
        : content.kind === "reasoning"
          ? { ...content, text: content.text + delta }
          : content;
    return {
      ...document,
      revision: document.revision + 1,
      entries: [...document.entries.slice(0, -1), { ...last, content: nextContent }],
    };
  }
  const content: PresentationContent =
    kind === "response"
      ? { kind: "agent", markdown: delta }
      : { kind: "reasoning", text: delta, label: "Reasoning" };
  return {
    ...document,
    revision: document.revision + 1,
    streamingId: nextId,
    entries: [...document.entries, { id: nextId, content, timestamp }],
  };
}

/**
 * Add an entry while an answer streams, without ending that answer: it goes just before the
 * answer, which stays last and keeps taking deltas. Without an answer streaming it is appended.
 */
export function insertBeforeDocumentStream(
  document: PresentationDocument,
  entry: PresentationEntry,
): PresentationDocument {
  const last = document.entries.at(-1);
  if (last === undefined || last.id !== document.streamingId || last.content.kind !== "agent") {
    return appendDocumentEntries(settleDocumentStream(document), [entry]);
  }
  return {
    ...document,
    revision: document.revision + 1,
    entries: [...document.entries.slice(0, -1), entry, last],
  };
}

export function settleDocumentStream(document: PresentationDocument): PresentationDocument {
  if (document.streamingId === undefined) return document;
  const { streamingId: _streamingId, ...settled } = document;
  return { ...settled, revision: document.revision + 1 };
}

/** Transient renderer state; accepted source text is never paced or collapsed. */
export interface DocumentViewOptions {
  readonly expandedReasoningIds?: ReadonlySet<string>;
  readonly liveReasoningIds?: ReadonlySet<string>;
  readonly hiddenReasoningIds?: ReadonlySet<string>;
  readonly streamReveal?: { readonly id: string; readonly length: number } | null;
}

/** Fold settled reasoning within a user turn without changing durable source facts. */
export function projectDocumentEntries(
  document: PresentationDocument,
  options: DocumentViewOptions = {},
): readonly PresentationEntry[] {
  const projected: Array<PresentationEntry | undefined> = [];
  let thoughtIndex: number | undefined;
  for (const original of document.entries) {
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
  return projected.filter((entry): entry is PresentationEntry => entry !== undefined);
}

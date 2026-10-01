/**
 * Derived classic Ink output. Safe Markdown prefixes become append-only Static
 * slices while one live tail remains bounded. These slices never own source
 * text: discarding this projection leaves the authoritative document intact.
 */
import type {
  PresentationContent,
  PresentationDocument,
  PresentationEntry,
} from "@jazz/core/types/presentation-content";
import {
  createStreamSplitScanner,
  type StreamSplitScanner,
} from "../../presentation/markdown-split";
import { outputFromEntry, projectDocumentEntries, type DocumentViewOptions } from "../document";
import type { OutputEntryWithId } from "../types";
export type StreamKind = "response" | "reasoning";
export interface PendingStream {
  readonly id: string;
  readonly kind: StreamKind;
  readonly rawTail: string;
  readonly splitScanner: StreamSplitScanner;
}

function sliceTextContent(content: PresentationContent, text: string): PresentationContent {
  if (content.kind === "agent")
    return { ...content, markdown: Buffer.from(text, "utf16le").toString("utf16le") };
  if (content.kind === "reasoning")
    return { ...content, text: Buffer.from(text, "utf16le").toString("utf16le") };
  return content;
}

export interface ClassicProjection {
  readonly entries: readonly OutputEntryWithId[];
  readonly pending: PendingStream | null;
}

/** Own one instance per terminal adapter. Caches are derived and can be discarded. */
export function createClassicProjection(): (
  document: PresentationDocument,
  generation?: number,
  options?: DocumentViewOptions,
) => ClassicProjection {
  let activeId: string | undefined;
  let consumed = 0;
  let slices: OutputEntryWithId[] = [];
  let scanner = createStreamSplitScanner();
  const completed = new Map<
    string,
    { readonly source: PresentationEntry; readonly entries: readonly OutputEntryWithId[] }
  >();
  let generationId: string | undefined;
  let lastGeneration = -1;
  let emitted: OutputEntryWithId[] = [];
  const emittedIds = new Set<string>();
  return (document, generation = 0, options = {}) => {
    if (generationId !== document.id || lastGeneration !== generation) {
      lastGeneration = generation;
      generationId = document.id;
      completed.clear();
      emitted = [];
      emittedIds.clear();
      activeId = undefined;
      consumed = 0;
      slices = [];
      scanner = createStreamSplitScanner();
    }
    const entries: OutputEntryWithId[] = [];
    let pending: PendingStream | null = null;
    for (const source of projectDocumentEntries(document, options)) {
      const content = source.content;
      const raw =
        content.kind === "agent"
          ? content.markdown
          : content.kind === "reasoning"
            ? content.text
            : undefined;
      if (source.id === document.streamingId && raw !== undefined) {
        if (activeId !== source.id) {
          activeId = source.id;
          consumed = 0;
          slices = [];
          scanner = createStreamSplitScanner();
        }
        const tail = raw.slice(consumed);
        const split = scanner.evaluate(tail);
        if (split > 0) {
          slices.push({
            ...outputFromEntry(source),
            id: `${source.id}:slice:${String(consumed)}`,
            message: sliceTextContent(content, tail.slice(0, split)),
          });
          consumed += split;
          scanner = createStreamSplitScanner();
        }
        entries.push(...slices);
        pending = {
          id: source.id,
          kind: content.kind === "agent" ? "response" : "reasoning",
          rawTail: raw.slice(consumed),
          splitScanner: scanner,
        };
        continue;
      }
      const hit = completed.get(source.id);
      if (hit?.source === source) {
        entries.push(...hit.entries);
        continue;
      }
      const projected =
        activeId === source.id && raw !== undefined
          ? [
              ...slices,
              {
                ...outputFromEntry(source),
                id: `${source.id}:slice:${String(consumed)}`,
                message: sliceTextContent(content, raw.slice(consumed)),
              },
            ]
          : [outputFromEntry(source)];
      completed.set(source.id, { source, entries: projected });
      entries.push(...projected);
      if (activeId === source.id) activeId = undefined;
    }
    const current = new Map(entries.map((entry) => [entry.id, entry]));
    let changed = false;
    const updated = emitted.map((entry) => {
      const next = current.get(entry.id) ?? entry;
      if (next !== entry) changed = true;
      return next;
    });
    const added = entries.filter((entry) => !emittedIds.has(entry.id));
    if (added.length > 0) {
      for (const entry of added) emittedIds.add(entry.id);
      emitted = [...updated, ...added];
    } else if (changed) emitted = updated;
    return { entries: emitted, pending };
  };
}

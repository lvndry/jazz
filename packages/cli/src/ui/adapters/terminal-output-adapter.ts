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
import {
  createEarlierTurnsProjection,
  outputFromEntry,
  projectEntries,
  transcriptDocument,
  type DocumentViewOptions,
} from "../document";
import type { OutputEntryWithId } from "../types";
export type StreamKind = "response" | "reasoning";
export interface PendingStream {
  readonly id: string;
  readonly kind: StreamKind;
  readonly rawTail: string;
  readonly splitScanner: StreamSplitScanner;
}

/**
 * A promoted slice of a still-streaming answer. The text is copied out: a substring would keep
 * alive the whole intermediate string it was cut from, one per slice.
 */
function copiedSliceContent(content: PresentationContent, text: string): PresentationContent {
  if (content.kind === "agent")
    return { ...content, markdown: Buffer.from(text, "utf16le").toString("utf16le") };
  if (content.kind === "reasoning")
    return { ...content, text: Buffer.from(text, "utf16le").toString("utf16le") };
  return content;
}

/**
 * A slice of a settled answer, cut from its final text. Every slice shares that one string,
 * which the document keeps anyway, so a settled answer is held once.
 */
function settledSliceContent(content: PresentationContent, text: string): PresentationContent {
  if (content.kind === "agent") return { ...content, markdown: text };
  if (content.kind === "reasoning") return { ...content, text };
  return content;
}

function sourceText(content: PresentationContent): string | undefined {
  return content.kind === "agent"
    ? content.markdown
    : content.kind === "reasoning"
      ? content.text
      : undefined;
}

/** Two projected entries that print the same; folded reasoning is rebuilt on every projection. */
function sameSource(previous: PresentationEntry, next: PresentationEntry): boolean {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.timestamp !== next.timestamp) return false;
  const before = previous.content;
  const after = next.content;
  return (
    before.kind === "reasoning" &&
    after.kind === "reasoning" &&
    before.text === after.text &&
    before.label === after.label &&
    before.durationMs === after.durationMs &&
    before.steps === after.steps &&
    before.tokens === after.tokens
  );
}

function viewSets(options: DocumentViewOptions): readonly (ReadonlySet<string> | undefined)[] {
  return [options.expandedReasoningIds, options.liveReasoningIds, options.hiddenReasoningIds];
}

export interface ClassicViewOptions extends DocumentViewOptions {
  /** Reasoning printed again below the transcript, oldest first; the list only grows. */
  readonly replays?: readonly OutputEntryWithId[];
}

export interface ClassicProjection {
  readonly entries: readonly OutputEntryWithId[];
  readonly pending: PendingStream | null;
}

/**
 * Own one instance per terminal adapter. Caches are derived and can be discarded.
 *
 * Ink's Static prints only the items past the count it already printed, so `entries` only
 * grows: an entry keeps its position once added and a changed entry is replaced in place.
 * Earlier turns are projected once and extended as turns end; each call re-projects only the
 * current turn.
 */
export function createClassicProjection(): (
  document: PresentationDocument,
  generation?: number,
  options?: ClassicViewOptions,
) => ClassicProjection {
  let generationId: string | undefined;
  let lastGeneration = -1;
  let streamingId: string | undefined;
  let pending: PendingStream | null = null;
  let activeId: string | undefined;
  let consumed = 0;
  let slices: OutputEntryWithId[] = [];
  let sliceStarts: number[] = [];
  let scanner = createStreamSplitScanner();
  /** Where each streamed answer was cut into slices, so a re-projection cuts it the same way. */
  let settledSliceStarts = new Map<string, readonly number[]>();
  /** The current turn's outputs, so an unchanged entry keeps its objects across calls. */
  let turnOutputs = new Map<
    string,
    { readonly source: PresentationEntry; readonly entries: readonly OutputEntryWithId[] }
  >();
  let emitted: OutputEntryWithId[] = [];
  let emittedIndex = new Map<string, number>();
  let placedEarlier: readonly OutputEntryWithId[] | undefined;
  let replaysPlaced = 0;

  const streamingOutputs = (
    source: PresentationEntry,
    content: PresentationContent,
    raw: string,
  ): readonly OutputEntryWithId[] => {
    if (activeId !== source.id) {
      activeId = source.id;
      consumed = 0;
      slices = [];
      sliceStarts = [];
      scanner = createStreamSplitScanner();
    }
    const tail = raw.slice(consumed);
    const split = scanner.evaluate(tail);
    if (split > 0) {
      slices = [
        ...slices,
        {
          ...outputFromEntry(source),
          id: `${source.id}:slice:${String(consumed)}`,
          message: copiedSliceContent(content, tail.slice(0, split)),
        },
      ];
      sliceStarts.push(consumed);
      consumed += split;
      scanner = createStreamSplitScanner();
    }
    pending = {
      id: source.id,
      kind: content.kind === "agent" ? "response" : "reasoning",
      rawTail: raw.slice(consumed),
      splitScanner: scanner,
    };
    return slices;
  };

  const outputsFor = (source: PresentationEntry): readonly OutputEntryWithId[] => {
    const content = source.content;
    const raw = sourceText(content);
    if (source.id === streamingId && raw !== undefined) {
      return streamingOutputs(source, content, raw);
    }
    const hit = turnOutputs.get(source.id);
    if (hit !== undefined && sameSource(hit.source, source)) {
      return hit.entries;
    }
    if (activeId === source.id) {
      settledSliceStarts.set(source.id, [...sliceStarts, consumed]);
      activeId = undefined;
      slices = [];
      sliceStarts = [];
    }
    const starts = settledSliceStarts.get(source.id);
    if (starts === undefined || raw === undefined) {
      return [outputFromEntry(source)];
    }
    return starts.map((start, index) => ({
      ...outputFromEntry(source),
      id: `${source.id}:slice:${String(start)}`,
      message: settledSliceContent(content, raw.slice(start, starts[index + 1] ?? raw.length)),
    }));
  };

  const projectTurns = (
    entries: readonly PresentationEntry[],
    options: DocumentViewOptions,
  ): OutputEntryWithId[] => {
    const outputs: OutputEntryWithId[] = [];
    for (const source of projectEntries(entries, options)) {
      const projected = outputsFor(source);
      if (source.id !== streamingId) {
        turnOutputs.set(source.id, { source, entries: projected });
      }
      outputs.push(...projected);
    }
    return outputs;
  };

  let earlier = createEarlierTurnsProjection(projectTurns, viewSets);

  return (document, generation = 0, options = {}) => {
    if (generationId !== document.id || lastGeneration !== generation) {
      lastGeneration = generation;
      generationId = document.id;
      activeId = undefined;
      consumed = 0;
      slices = [];
      sliceStarts = [];
      scanner = createStreamSplitScanner();
      settledSliceStarts = new Map();
      turnOutputs = new Map();
      emitted = [];
      emittedIndex = new Map();
      placedEarlier = undefined;
      replaysPlaced = 0;
      earlier = createEarlierTurnsProjection(projectTurns, viewSets);
    }
    const source = transcriptDocument(document);
    streamingId = source.streamingId;
    pending = null;
    // Earlier turns go first: a turn that just ended still finds its outputs in turnOutputs.
    const earlierOutputs = earlier(source.earlierTurns, options);
    turnOutputs = new Map();
    const currentOutputs = projectTurns(source.currentTurn, options);

    let next: OutputEntryWithId[] | undefined;
    const place = (entry: OutputEntryWithId): void => {
      const index = emittedIndex.get(entry.id);
      if (index === undefined) {
        next ??= [...emitted];
        emittedIndex.set(entry.id, next.length);
        next.push(entry);
      } else if ((next ?? emitted)[index] !== entry) {
        next ??= [...emitted];
        next[index] = entry;
      }
    };
    if (earlierOutputs !== placedEarlier) {
      for (const entry of earlierOutputs) place(entry);
      placedEarlier = earlierOutputs;
    }
    for (const entry of currentOutputs) place(entry);
    const replays = options.replays ?? [];
    for (; replaysPlaced < replays.length; replaysPlaced += 1) {
      const replay = replays[replaysPlaced];
      if (replay !== undefined) place(replay);
    }
    if (next !== undefined) emitted = next;
    return { entries: emitted, pending };
  };
}

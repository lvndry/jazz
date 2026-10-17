/**
 * The fullscreen transcript's projection from the presentation document to
 * blocks. Pure: the bridge owns one projector per mounted transcript and the
 * layout downstream relies on unchanged blocks keeping their identity.
 */
import type { PresentationContent, PresentationEntry } from "@jazz/core/types/presentation-content";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { foldTurn } from "./turn-fold";
import type { Block } from "./types";
import { formatTurnReceipt } from "../../presentation/turn-receipt";
import {
  contentFromOutput,
  createEarlierTurnsProjection,
  outputFromEntry,
  projectEntries,
  transcriptDocument,
} from "../document";
import type { EphemeralRegion, PresentationSnapshot } from "../store";
import type { OutputEntry } from "../types";

/** The view state a block shows besides its entry. */
interface BlockView {
  readonly expandedReasoningIds: ReadonlySet<string>;
  readonly liveReasoningIds: ReadonlySet<string>;
  readonly expandedReceiptIds: ReadonlySet<string>;
  readonly streamingId: string | undefined;
}

/** One entry's block, or undefined for an entry this transcript leaves out. */
function entryBlock(
  id: string,
  content: PresentationContent,
  seq: number,
  view: BlockView,
): Block | undefined {
  switch (content.kind) {
    case "user":
      return { id, seq, kind: "user", text: content.text };
    case "agent":
      return {
        id,
        seq,
        kind: "agent",
        markdown: content.markdown,
        ...(id === view.streamingId ? { streaming: true } : {}),
      };
    case "tool":
      return {
        id,
        seq,
        kind: "tool",
        ...content.receipt,
        ...(view.expandedReceiptIds.has(id) ? { expanded: true } : {}),
      };
    case "reasoning":
      return {
        id,
        seq,
        kind: "reasoning",
        text: content.text,
        collapsed: content.durationMs !== undefined && !view.expandedReasoningIds.has(id),
        ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
        ...(content.steps === undefined ? {} : { steps: content.steps }),
        ...(content.tokens === undefined ? {} : { tokens: content.tokens }),
        ...(id === view.streamingId || view.liveReasoningIds.has(id) ? { live: true } : {}),
        ...(content.text.trim().length === 0 ? { readable: false } : {}),
      };
    case "report":
      return { id, seq, kind: "report", report: content.report };
    case "stopped":
      return { id, seq, kind: "stopped", ...content.summary };
    case "turn-receipt": {
      const text = formatTurnReceipt(content);
      return text === undefined ? undefined : { id, seq, kind: "notice", text, tone: "receipt" };
    }
    case "expanded":
      return {
        id,
        seq,
        kind: "tool",
        app: "",
        summary: "",
        status: "ok",
        expanded: true,
        detail: content.text,
      };
    case "notice":
      if (content.audience === "classic" || content.text.trim().length === 0) {
        return undefined;
      }
      return {
        id,
        seq,
        kind: "notice",
        text: content.text,
        tone: content.tone === "warn" ? "warn" : content.tone === "error" ? "error" : "info",
      };
    case "header":
      return undefined;
  }
}

/**
 * The content a block is built from: what printing the entry as terminal output and reading it
 * back yields, so plain user and notice text loses terminal escapes.
 */
function displayContent(content: PresentationContent): PresentationContent {
  if (content.kind === "user") {
    const text = stripAnsiCodes(content.text);
    return text === content.text ? content : { kind: "user", text };
  }
  if (content.kind === "notice" && content.audience === undefined) {
    const text = stripAnsiCodes(content.text);
    return text === content.text ? content : { kind: "notice", text, tone: content.tone };
  }
  return content;
}

/** Live sub-agent lanes and reasoning panels whose source entry is not shown yet. */
function regionBlocks(
  regions: readonly EphemeralRegion[],
  shown: (id: string) => boolean,
  firstSeq: number,
): Block[] {
  const blocks: Block[] = [];
  let seq = firstSeq;
  let lane = 0;
  for (const region of regions) {
    if (region.kind === "reasoning" && shown(region.id)) continue;
    if (region.kind === "reasoning")
      blocks.push({
        id: region.id,
        seq: seq++,
        kind: "reasoning",
        text: stripAnsiCodes(region.tail.join("\n")),
        collapsed: false,
        live: true,
      });
    else
      blocks.push({
        id: region.id,
        seq: seq++,
        kind: "lane",
        name: region.label,
        // The tail holds the Ink panel's colored lines; this surface styles text itself.
        ask: stripAnsiCodes(region.tail.at(-1) ?? ""),
        lane: lane++,
        state: "running",
      });
  }
  return blocks;
}

/** Project semantic source entries into fullscreen document blocks. */
export function blocksFrom(
  entries: readonly OutputEntry[],
  streaming: string,
  regions: readonly EphemeralRegion[],
  expandedReasoningIds: ReadonlySet<string> = new Set(),
  streamingId?: string,
  liveReasoningIds: ReadonlySet<string> = new Set(),
  expandedReceiptIds: ReadonlySet<string> = new Set(),
): Block[] {
  const view: BlockView = {
    expandedReasoningIds,
    liveReasoningIds,
    expandedReceiptIds,
    streamingId,
  };
  const blocks: Block[] = [];
  let seq = 0;
  const sourceEntries = entries.map((entry, index) => ({
    id: entry.id ?? `entry:${String(index)}`,
    content: contentFromOutput(entry),
    timestamp: entry.timestamp.toISOString(),
  }));
  for (const source of projectEntries(sourceEntries, { expandedReasoningIds, liveReasoningIds })) {
    const block = entryBlock(source.id, contentFromOutput(outputFromEntry(source)), seq, view);
    if (block !== undefined) {
      blocks.push(block);
      seq += 1;
    }
  }
  if (streaming.trim().length > 0)
    blocks.push({
      id: streamingId ?? "streaming",
      seq: seq++,
      kind: "agent",
      markdown: streaming,
      streaming: true,
    });
  blocks.push(...regionBlocks(regions, (id) => entries.some((entry) => entry.id === id), seq));
  return foldTurn(blocks);
}

// `previous` is undefined on the first block or a missing cache slot; still
// compare so sharing can no-op without a null check at every call site.
function sameBlock(previous: Block | undefined, current: Block): previous is Block {
  if (previous === undefined || previous.kind !== current.kind) return false;
  if (previous.id !== current.id || previous.seq !== current.seq) return false;
  switch (previous.kind) {
    case "user":
      return (
        current.kind === "user" && previous.text === current.text && previous.at === current.at
      );
    case "agent":
      return (
        current.kind === "agent" &&
        previous.markdown === current.markdown &&
        previous.streaming === current.streaming
      );
    case "reasoning":
      return (
        current.kind === "reasoning" &&
        previous.text === current.text &&
        previous.collapsed === current.collapsed &&
        previous.steps === current.steps &&
        previous.durationMs === current.durationMs &&
        previous.tokens === current.tokens &&
        previous.live === current.live &&
        previous.readable === current.readable
      );
    case "tool":
      return (
        current.kind === "tool" &&
        previous.app === current.app &&
        previous.summary === current.summary &&
        previous.args === current.args &&
        previous.status === current.status &&
        previous.reason === current.reason &&
        previous.remedyKey === current.remedyKey &&
        previous.notDone === current.notDone &&
        previous.durationMs === current.durationMs &&
        previous.detail === current.detail &&
        previous.outputPreview === current.outputPreview &&
        previous.expanded === current.expanded &&
        previous.classifiedRisk === current.classifiedRisk
      );
    case "notice":
      return (
        current.kind === "notice" &&
        previous.text === current.text &&
        previous.tone === current.tone
      );
    case "report":
      return current.kind === "report" && previous.report === current.report;
    case "divider":
      return current.kind === "divider" && previous.label === current.label;
    case "stopped":
      return (
        current.kind === "stopped" &&
        previous.elapsedMs === current.elapsedMs &&
        previous.done.join("\n") === current.done.join("\n") &&
        previous.notDone.join("\n") === current.notDone.join("\n")
      );
    case "lane":
      return (
        current.kind === "lane" &&
        previous.name === current.name &&
        previous.ask === current.ask &&
        previous.lane === current.lane &&
        previous.state === current.state &&
        previous.result === current.result &&
        previous.steps === current.steps
      );
  }
}

export function shareUnchangedBlocks(
  previous: readonly Block[],
  next: readonly Block[],
): readonly Block[] {
  if (previous.length === 0) return next;
  let changed = previous.length !== next.length;
  const shared = next.map((current, index) => {
    const cached = previous[index];
    if (sameBlock(cached, current)) return cached;
    changed = true;
    return current;
  });
  return changed ? shared : previous;
}

export interface TranscriptBlockSources {
  readonly outputs: readonly OutputEntry[];
  readonly streaming: string;
  readonly regions: readonly EphemeralRegion[];
  readonly expandedReasoningIds?: ReadonlySet<string>;
  readonly streamingId?: string;
  readonly liveReasoningIds?: ReadonlySet<string>;
  readonly expandedReceiptIds?: ReadonlySet<string>;
}

export function transcriptBlocks(
  sources: TranscriptBlockSources,
  previous: readonly Block[] = [],
): readonly Block[] {
  return shareUnchangedBlocks(
    previous,
    blocksFrom(
      sources.outputs,
      sources.streaming,
      sources.regions,
      sources.expandedReasoningIds,
      sources.streamingId,
      sources.liveReasoningIds,
      sources.expandedReceiptIds,
    ),
  );
}

/** The presentation facts the main transcript is projected from. */
export type FullscreenTranscriptSources = Pick<
  PresentationSnapshot,
  "document" | "streamReveal" | "expandedReasoningIds" | "expandedReceiptIds" | "liveReasoningIds"
>;

interface TranscriptView extends BlockView {
  readonly streamReveal: PresentationSnapshot["streamReveal"];
}

function sameItems(previous: readonly Block[], next: readonly Block[]): boolean {
  return previous.length === next.length && previous.every((block, index) => block === next[index]);
}

/** Whether the first pass keeps an entry: a reasoning entry with no text and no duration yet is left out. */
function revealed(entry: PresentationEntry): boolean {
  return (
    entry.content.kind !== "reasoning" ||
    entry.content.text.length > 0 ||
    entry.content.durationMs !== undefined
  );
}

/**
 * One projector per mounted transcript. Earlier turns are projected once and reused until a
 * turn ends or a view set changes for one of their entries; each call re-projects only the
 * current turn and the live regions. A block equal to the one shown before keeps that object,
 * so the layout reuses its measured rows.
 */
export function createFullscreenTranscript(): (
  sources: FullscreenTranscriptSources,
  regions: readonly EphemeralRegion[],
) => readonly Block[] {
  let shownById = new Map<string, Block>();
  let earlierShown: readonly Block[] = [];
  let tailShown: readonly Block[] = [];
  let shown: readonly Block[] = [];
  const share = (block: Block): Block => {
    const previous = shownById.get(block.id);
    return sameBlock(previous, block) ? previous : block;
  };
  /** Blocks of whole turns; `firstSeq` continues the numbering of the turns before them. */
  const projectTurns = (
    entries: readonly PresentationEntry[],
    view: TranscriptView,
    firstSeq: number,
    revealedIds?: Set<string>,
  ): Block[] => {
    const blocks: Block[] = [];
    let turnStart = 0;
    while (turnStart < entries.length) {
      let turnEnd = turnStart + 1;
      while (turnEnd < entries.length && entries[turnEnd]?.content.kind !== "user") {
        turnEnd += 1;
      }
      const turn =
        turnStart === 0 && turnEnd === entries.length ? entries : entries.slice(turnStart, turnEnd);
      const firstPass = projectEntries(turn, { streamReveal: view.streamReveal });
      const turnBlocks: Block[] = [];
      for (const source of projectEntries(firstPass, {
        expandedReasoningIds: view.expandedReasoningIds,
        liveReasoningIds: view.liveReasoningIds,
      })) {
        const block = entryBlock(
          source.id,
          displayContent(source.content),
          firstSeq + blocks.length + turnBlocks.length,
          view,
        );
        if (block !== undefined) {
          turnBlocks.push(block);
        }
      }
      for (const block of foldTurn(turnBlocks)) {
        blocks.push(share(block));
      }
      if (revealedIds !== undefined) {
        for (const source of firstPass) {
          revealedIds.add(source.id);
        }
      }
      turnStart = turnEnd;
    }
    return blocks;
  };
  const earlier = createEarlierTurnsProjection(projectTurns, (view: TranscriptView) => [
    view.expandedReasoningIds,
    view.liveReasoningIds,
    view.expandedReceiptIds,
  ]);
  return (sources, regions) => {
    const document = transcriptDocument(sources.document);
    const view: TranscriptView = {
      expandedReasoningIds: sources.expandedReasoningIds,
      liveReasoningIds: sources.liveReasoningIds,
      expandedReceiptIds: sources.expandedReceiptIds,
      streamingId: document.streamingId,
      streamReveal: sources.streamReveal,
    };
    const earlierBlocks = earlier(document.earlierTurns, view);
    const revealedIds = new Set<string>();
    const currentBlocks = projectTurns(
      document.currentTurn,
      view,
      earlierBlocks.length,
      revealedIds,
    );
    const shownInDocument = (id: string): boolean => {
      if (revealedIds.has(id)) {
        return true;
      }
      if (document.currentTurn.some((entry) => entry.id === id)) {
        return false;
      }
      const earlierEntry = document.earlierTurns.find((entry) => entry.id === id);
      return earlierEntry !== undefined && revealed(earlierEntry);
    };
    const tail = [
      ...currentBlocks,
      ...regionBlocks(regions, shownInDocument, earlierBlocks.length + currentBlocks.length).map(
        share,
      ),
    ];
    if (earlierBlocks === earlierShown && sameItems(tailShown, tail)) {
      return shown;
    }
    if (earlierBlocks !== earlierShown) {
      shownById = new Map(earlierBlocks.map((block) => [block.id, block]));
    }
    for (const block of tail) {
      shownById.set(block.id, block);
    }
    earlierShown = earlierBlocks;
    tailShown = tail;
    shown = earlierBlocks.length === 0 ? tail : [...earlierBlocks, ...tail];
    return shown;
  };
}

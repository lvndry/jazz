/**
 * The fullscreen transcript's projection from the presentation document to
 * blocks. Pure: the bridge owns one projector per mounted transcript and the
 * layout downstream relies on unchanged blocks keeping their identity.
 */
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { foldTurn } from "./turn-fold";
import type { Block } from "./types";
import { formatTurnReceipt } from "../../presentation/turn-receipt";
import { contentFromOutput, outputFromEntry, projectDocumentEntries } from "../document";
import type { EphemeralRegion, PresentationSnapshot } from "../store";
import type { OutputEntry } from "../types";

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
  const blocks: Block[] = [];
  let seq = 0;
  const sourceEntries = entries.map((entry, index) => ({
    id: entry.id ?? `entry:${String(index)}`,
    content: contentFromOutput(entry),
    timestamp: entry.timestamp.toISOString(),
  }));
  for (const source of projectDocumentEntries(
    { id: "projection", revision: 0, entries: sourceEntries },
    { expandedReasoningIds, liveReasoningIds },
  )) {
    const entry = outputFromEntry(source);
    const id = source.id;
    const content = contentFromOutput(entry);
    switch (content.kind) {
      case "user":
        blocks.push({ id, seq: seq++, kind: "user", text: content.text });
        break;
      case "agent":
        blocks.push({
          id,
          seq: seq++,
          kind: "agent",
          markdown: content.markdown,
          ...(id === streamingId ? { streaming: true } : {}),
        });
        break;
      case "tool":
        blocks.push({
          id,
          seq: seq++,
          kind: "tool",
          ...content.receipt,
          ...(expandedReceiptIds.has(id) ? { expanded: true } : {}),
        });
        break;
      case "reasoning":
        blocks.push({
          id,
          seq: seq++,
          kind: "reasoning",
          text: content.text,
          collapsed: content.durationMs !== undefined && !expandedReasoningIds.has(id),
          ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
          ...(content.steps === undefined ? {} : { steps: content.steps }),
          ...(content.tokens === undefined ? {} : { tokens: content.tokens }),
          ...(id === streamingId || liveReasoningIds.has(id) ? { live: true } : {}),
          ...(content.text.trim().length === 0 ? { readable: false } : {}),
        });
        break;
      case "report":
        blocks.push({ id, seq: seq++, kind: "report", report: content.report });
        break;
      case "stopped":
        blocks.push({ id, seq: seq++, kind: "stopped", ...content.summary });
        break;
      case "turn-receipt": {
        const text = formatTurnReceipt(content);
        if (text !== undefined)
          blocks.push({ id, seq: seq++, kind: "notice", text, tone: "receipt" });
        break;
      }
      case "expanded":
        blocks.push({
          id,
          seq: seq++,
          kind: "tool",
          app: "",
          summary: "",
          status: "ok",
          expanded: true,
          detail: content.text,
        });
        break;
      case "notice":
        if (content.audience !== "classic" && content.text.trim().length > 0)
          blocks.push({
            id,
            seq: seq++,
            kind: "notice",
            text: content.text,
            tone: content.tone === "warn" ? "warn" : content.tone === "error" ? "error" : "info",
          });
        break;
      case "header":
        break;
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
  let lane = 0;
  for (const region of regions) {
    if (region.kind === "reasoning" && entries.some((entry) => entry.id === region.id)) continue;
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

/** One projector per mounted transcript; it keeps the previous blocks so unchanged ones are shared. */
export function createFullscreenTranscript(): (
  sources: FullscreenTranscriptSources,
  regions: readonly EphemeralRegion[],
) => readonly Block[] {
  let previous: readonly Block[] = [];
  return (sources, regions) => {
    const outputs = projectDocumentEntries(sources.document, {
      streamReveal: sources.streamReveal,
    }).map(outputFromEntry);
    previous = transcriptBlocks(
      {
        outputs,
        streaming: "",
        regions,
        expandedReasoningIds: sources.expandedReasoningIds,
        expandedReceiptIds: sources.expandedReceiptIds,
        liveReasoningIds: sources.liveReasoningIds,
        ...(sources.document.streamingId === undefined
          ? {}
          : { streamingId: sources.document.streamingId }),
      },
      previous,
    );
    return previous;
  };
}

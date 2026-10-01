/**
 * Owns fullscreen reading position independently of terminal painting.
 *
 * A document has either live-edge intent or an anchored reading position. Anchors
 * refer to a block and an unwrapped semantic-text position, never a wrap-line
 * number. Positions are UTF-16 offsets in displayed content (after Markdown
 * syntax is interpreted), with row boundaries supplied by grapheme-safe layout.
 * They are not offsets into raw Markdown. Folding/deletion resolves within the
 * same block, then to a surviving neighboring block, then clamps the old position.
 *
 * `projectViewport` is pure. `useViewportController` commits its projected state
 * in a layout effect; neither projection nor transcript rendering mutates refs.
 * Keyboard, wheel and drag all use the same navigation transition. Each document
 * retains only anchors and geometry, so visiting a child does not retain its rows.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface RowSource {
  readonly blockId: string;
  readonly partId: string;
  readonly start: number;
  readonly end: number;
}

export interface ViewportRow {
  readonly key: string;
  readonly source: RowSource;
}

/** Compact semantic index; row realization happens only for the selected window. */
export interface ViewportRowIndex<Row extends ViewportRow = ViewportRow> {
  readonly length: number;
  sourceAt(position: number): RowSource | undefined;
  sourceRow(source: RowSource): number | undefined;
  hasPart(source: RowSource): boolean;
  blockBounds(blockId: string): { readonly first: number; readonly last: number } | undefined;
  window(top: number, count: number): readonly Row[];
}

interface Anchor {
  readonly source: RowSource;
  readonly neighborBefore?: RowSource;
  readonly neighborAfter?: RowSource;
}

export interface ViewportInput<Row extends ViewportRow = ViewportRow> {
  readonly documentId: string;
  readonly index: ViewportRowIndex<Row>;
  readonly visibleCount: number;
  readonly width: number;
  readonly occluded: boolean;
  readonly submitCount: number;
}

export interface ViewportState {
  readonly mode: "live" | "anchored";
  readonly anchor?: Anchor | undefined;
  readonly seenTail?: Anchor | undefined;
  readonly seenRowCount: number;
  readonly top: number;
  readonly rowCount: number;
  readonly visibleCount: number;
  readonly width: number;
  readonly occluded: boolean;
  readonly submitCount: number;
  readonly liveTop?: Anchor | undefined;
  readonly occludedAnchor?: Anchor | undefined;
}

export interface ViewportSnapshot<Row extends ViewportRow = ViewportRow> {
  readonly state: ViewportState;
  readonly rows: readonly Row[];
  readonly top: number;
  readonly newBelow: number;
  readonly watchingLiveEdge: boolean;
}

const clampTop = (top: number, count: number, height: number): number =>
  Math.max(0, Math.min(Math.trunc(top), Math.max(0, count - height)));

function anchorAt(index: ViewportRowIndex, top: number): Anchor | undefined {
  const source = index.sourceAt(top);
  if (source === undefined) return undefined;
  const bounds = index.blockBounds(source.blockId);
  const before = index.sourceAt((bounds?.first ?? top) - 1);
  const after = index.sourceAt((bounds?.last ?? top) + 1);
  return {
    source,
    ...(before === undefined ? {} : { neighborBefore: before }),
    ...(after === undefined ? {} : { neighborAfter: after }),
  };
}

function resolveAnchor(
  index: ViewportRowIndex,
  anchor: Anchor | undefined,
  fallback: number,
): number {
  if (anchor === undefined) return fallback;
  return (
    index.sourceRow(anchor.source) ??
    (anchor.neighborAfter === undefined ? undefined : index.sourceRow(anchor.neighborAfter)) ??
    (anchor.neighborBefore === undefined ? undefined : index.sourceRow(anchor.neighborBefore)) ??
    fallback
  );
}

function tailSource(index: ViewportRowIndex): Anchor | undefined {
  const anchor = anchorAt(index, index.length - 1);
  if (anchor === undefined) return undefined;
  return {
    ...anchor,
    source: { ...anchor.source, start: Math.max(anchor.source.start, anchor.source.end - 1) },
  };
}

/** A removed live tail resolves to its preceding receipt, not the start of its old document. */
function seenTailRow(index: ViewportRowIndex, anchor: Anchor): number | undefined {
  const source = anchor.source;
  if (index.hasPart(source)) return index.sourceRow(source);
  const bounds = index.blockBounds(source.blockId);
  if (bounds !== undefined) return bounds.last;
  if (anchor.neighborBefore !== undefined) {
    return seenTailRow(index, {
      source: {
        ...anchor.neighborBefore,
        start: Math.max(anchor.neighborBefore.start, anchor.neighborBefore.end - 1),
      },
    });
  }
  return undefined;
}

/** Reconcile a document/layout revision without changing the reader's follow intent. */
export function projectViewport<Row extends ViewportRow>(
  previous: ViewportState | undefined,
  input: ViewportInput<Row>,
): ViewportSnapshot<Row> {
  const height = Math.max(0, Math.trunc(input.visibleCount));
  const submitted = previous !== undefined && input.submitCount !== previous.submitCount;
  const mode = submitted ? "live" : (previous?.mode ?? "live");
  const occludedAnchor =
    input.occluded && !submitted ? (previous?.occludedAnchor ?? previous?.liveTop) : undefined;
  const anchor = mode === "anchored" ? previous?.anchor : occludedAnchor;
  const top =
    mode === "live" && (!input.occluded || occludedAnchor === undefined)
      ? Math.max(0, input.index.length - height)
      : clampTop(
          resolveAnchor(input.index, anchor, previous?.top ?? 0),
          input.index.length,
          height,
        );
  const watchingLiveEdge = mode === "live" && !input.occluded;
  const seenTail =
    watchingLiveEdge || previous === undefined || submitted
      ? tailSource(input.index)
      : previous.seenTail;
  const seenRowCount =
    watchingLiveEdge || previous === undefined || submitted
      ? input.index.length
      : previous.seenRowCount;
  const seenRow = seenTail === undefined ? undefined : seenTailRow(input.index, seenTail);
  const newBelow = watchingLiveEdge
    ? 0
    : seenRow === undefined
      ? Math.max(0, input.index.length - seenRowCount)
      : Math.max(0, input.index.length - seenRow - 1);
  const liveTop = anchorAt(input.index, top);
  const state: ViewportState = {
    mode,
    top,
    rowCount: input.index.length,
    seenRowCount,
    visibleCount: height,
    width: input.width,
    occluded: input.occluded,
    submitCount: input.submitCount,
    ...(mode !== "anchored" || previous?.anchor === undefined ? {} : { anchor: previous.anchor }),
    ...(seenTail === undefined ? {} : { seenTail }),
    ...(occludedAnchor === undefined ? {} : { occludedAnchor }),
    ...(liveTop === undefined ? {} : { liveTop }),
  };
  return { state, top, newBelow, watchingLiveEdge, rows: input.index.window(top, height) };
}

/** User navigation is the only transition, besides submit, that re-arms live following. */
export function navigateViewport<Row extends ViewportRow>(
  previous: ViewportState | undefined,
  input: ViewportInput<Row>,
  delta: number,
  unit: "line" | "page" | "end" = "line",
): ViewportState {
  const current = projectViewport(previous, input);
  const height = current.state.visibleCount;
  const maxTop = Math.max(0, input.index.length - height);
  const step = unit === "page" ? Math.max(1, height - 1) : 1;
  const top =
    unit === "end"
      ? delta < 0
        ? 0
        : maxTop
      : clampTop(current.top + delta * step, input.index.length, height);
  const mode = top === maxTop && delta > 0 ? "live" : "anchored";
  const anchor = anchorAt(input.index, top);
  return {
    ...current.state,
    mode,
    top,
    ...(anchor === undefined ? {} : { anchor }),
    ...(current.state.mode === "live" ? { seenTail: tailSource(input.index) } : {}),
  };
}

/** Pause for selection before its first timer tick, retaining the same semantic top row. */
export function detachViewport<Row extends ViewportRow>(
  previous: ViewportState | undefined,
  input: ViewportInput<Row>,
): ViewportState {
  return navigateViewport(previous, input, 0);
}

export function useViewportController<Row extends ViewportRow>(
  input: ViewportInput<Row>,
): {
  readonly snapshot: ViewportSnapshot<Row>;
  readonly scrollBy: (delta: number, unit?: "line" | "page" | "end") => void;
  readonly detach: () => void;
} {
  const documents = useRef(new Map<string, ViewportState>());
  const activeDocument = useRef(input.documentId);
  const [revision, setRevision] = useState(0);
  const snapshot = useMemo(() => {
    const previous = documents.current.get(input.documentId);
    const restored =
      activeDocument.current !== input.documentId && previous !== undefined
        ? { ...previous, submitCount: input.submitCount }
        : previous;
    return projectViewport(restored, input);
  }, [revision, input]);
  useLayoutEffect(() => {
    documents.current.set(input.documentId, snapshot.state);
    activeDocument.current = input.documentId;
  }, [input.documentId, snapshot.state]);
  const scrollBy = useCallback(
    (delta: number, unit: "line" | "page" | "end" = "line") => {
      documents.current.set(
        input.documentId,
        navigateViewport(documents.current.get(input.documentId), input, delta, unit),
      );
      setRevision((current) => current + 1);
    },
    [input],
  );
  const detach = useCallback(() => {
    documents.current.set(
      input.documentId,
      detachViewport(documents.current.get(input.documentId), input),
    );
    setRevision((current) => current + 1);
  }, [input]);

  return { snapshot, scrollBy, detach };
}

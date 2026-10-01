/** @jsxImportSource @opentui/react */
/**
 * Paints the viewport controller's selected transcript rows. This component owns
 * only hover interaction; document layout, row caches and reading position live
 * outside the painter. Native scroll is disabled so every navigation source uses
 * the controller's semantic anchor.
 */
import "./transcript-surface";
import { TextAttributes, type MouseEvent as OTMouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { THEME } from "../theme";
import { linkAtColumn, openLink } from "./open-link";
import type { RenderRow, Segment } from "./transcript-layout";
import { measureFor, type Focus, type Viewport } from "./types";

const GUTTER = 2;
const RIGHT_MARGIN = 2;

function segmentAttributes(segment: Segment): number {
  let attributes = 0;
  if (segment.bold === true) attributes |= TextAttributes.BOLD;
  if (segment.italic === true) attributes |= TextAttributes.ITALIC;
  if (segment.underline === true) attributes |= TextAttributes.UNDERLINE;
  if (segment.strikethrough === true) attributes |= TextAttributes.STRIKETHROUGH;
  return attributes;
}

// ─── The region ──────────────────────────────────────────────────────────────

interface LinkHover {
  readonly hovered: string | undefined;
  readonly setHovered: (target: string | undefined) => void;
}

/**
 * Shared across rows so every row of a wrapped link underlines together, keyed
 * by target because a wrapped label becomes one segment per row.
 */
const LinkHoverContext = createContext<LinkHover>({
  hovered: undefined,
  setHovered: () => undefined,
});

/**
 * Opens the link under a click and reports the one under the pointer. The
 * terminal cannot do either itself: mouse capture keeps clicks from reaching it,
 * and OpenTUI drops OSC 8 targets on terminals it cannot confirm support them. A
 * press and release on different cells is a selection drag, not a click.
 */
function useLinkPointer(segments: readonly Segment[]): {
  readonly onMouseDown?: (event: OTMouseEvent) => void;
  readonly onMouseUp?: (event: OTMouseEvent) => void;
  readonly onMouseMove?: (event: OTMouseEvent) => void;
  readonly onMouseOut?: (event: OTMouseEvent) => void;
} {
  const { setHovered } = useContext(LinkHoverContext);
  const pressedAt = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  if (!segments.some((segment) => segment.link !== undefined)) {
    return {};
  }
  const linkUnder = (event: OTMouseEvent): string | undefined => {
    const origin = event.currentTarget;
    return origin === null ? undefined : linkAtColumn(segments, event.x - origin.x);
  };
  return {
    onMouseDown: (event) => {
      pressedAt.current = { x: event.x, y: event.y };
    },
    onMouseUp: (event) => {
      const pressed = pressedAt.current;
      pressedAt.current = undefined;
      if (pressed === undefined || pressed.x !== event.x || pressed.y !== event.y) {
        return;
      }
      const target = linkUnder(event);
      if (target !== undefined) {
        openLink(target);
      }
    },
    onMouseMove: (event) => {
      setHovered(linkUnder(event));
    },
    onMouseOut: () => {
      setHovered(undefined);
    },
  };
}

function Spans({ segments }: { segments: readonly Segment[] }): ReactNode {
  const linkPointer = useLinkPointer(segments);
  const { hovered } = useContext(LinkHoverContext);
  if (segments.length === 0) return null;
  return (
    <text
      style={{ wrapMode: "none", truncate: true }}
      {...linkPointer}
    >
      {segments.map((segment, index) => {
        // Links are always underlined, so hovering one lifts it to the full accent instead.
        const isHovered = hovered !== undefined && segment.link === hovered;
        const attributes = segmentAttributes(segment);
        const key = `${String(index)}:${segment.text}`;
        const style = {
          fg: isHovered ? THEME.primary : segment.fg,
          // OpenTUI text nodes honour `attributes`, not `bold`/`italic` booleans.
          ...(attributes === 0 ? {} : { attributes }),
        };
        if (segment.link !== undefined) {
          return (
            <a
              key={key}
              href={segment.link}
              style={style}
            >
              {segment.text}
            </a>
          );
        }
        return (
          <span
            key={key}
            style={style}
          >
            {segment.text}
          </span>
        );
      })}
    </text>
  );
}

function Row({ row, width }: { row: RenderRow; width: number }): ReactNode {
  const band = row.backgroundColor === undefined ? {} : { backgroundColor: row.backgroundColor };
  const strip = Math.max(0, measureFor(width).prose - row.contentWidth);
  return (
    <box
      style={{
        width,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        ...(row.bandFullWidth === true ? band : {}),
      }}
    >
      <box
        style={{ width: GUTTER, flexShrink: 0, ...(row.bandIncludesGutter === true ? band : {}) }}
      >
        <Spans segments={row.gutter} />
      </box>
      <box style={{ width: row.contentWidth, flexShrink: 0, ...band }}>
        <Spans segments={row.content} />
      </box>
      <box
        style={{ width: strip, flexShrink: 0, flexDirection: "row", justifyContent: "flex-end" }}
      >
        <Spans segments={row.meta} />
      </box>
      <box style={{ flexGrow: 1 }} />
      <box style={{ width: RIGHT_MARGIN, flexShrink: 0 }} />
    </box>
  );
}

export interface TranscriptProps {
  /** Already selected by the viewport controller; this component never navigates. */
  readonly rows: readonly RenderRow[];
  readonly viewport: Viewport;
  readonly focus: Focus;
  readonly newBelow?: number;
  readonly visibleCount?: number;
}

function TranscriptView({
  rows: visible,
  viewport,
  focus,
  newBelow,
  visibleCount,
}: TranscriptProps): ReactNode {
  const page = viewport.width;
  const windowHeight =
    visibleCount === undefined ? Math.max(1, viewport.height) : Math.max(0, visibleCount);
  const padCount = Math.max(0, windowHeight - visible.length);
  const [hoveredLink, setHoveredLink] = useState<string | undefined>(undefined);
  const linkHover = useMemo(
    () => ({ hovered: hoveredLink, setHovered: setHoveredLink }),
    [hoveredLink],
  );
  const renderer = useRenderer();
  const isHoveringLink = hoveredLink !== undefined;
  useEffect(() => {
    if (!isHoveringLink) return;
    renderer.setMousePointer("pointer");
    return () => {
      renderer.setMousePointer("default");
    };
  }, [isHoveringLink, renderer]);
  const marker =
    newBelow !== undefined && newBelow > 0 ? `${String(newBelow)} new below  end jumps` : undefined;

  return (
    <box
      style={{
        width: viewport.width,
        height: windowHeight,
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        maxHeight: windowHeight,
        overflow: "hidden",
        flexDirection: "column",
      }}
    >
      {/* OpenTUI only settles this region's layout when a scrollbox owns it.
          Sticky scroll is off: we window the rows ourselves so wheel and
          keyboard offsets are not snapped back to the live edge. */}
      <LinkHoverContext.Provider value={linkHover}>
        <transcript_surface
          focused={focus === "transcript"}
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            height: windowHeight,
            overflow: "hidden",
          }}
          stickyScroll={false}
          scrollY={false}
          scrollbarOptions={{ visible: false }}
        >
          {Array.from({ length: padCount }, (_, index) => (
            <box
              key={`pad:${String(index)}`}
              style={{ width: page, height: 1, flexShrink: 0 }}
            />
          ))}
          {visible.map((row) => (
            <Row
              key={row.key}
              row={row}
              width={page}
            />
          ))}
        </transcript_surface>
      </LinkHoverContext.Provider>

      {/* Overlay rather than a layout row so the transcript does not shift
          under the reader when the count appears. */}
      {marker === undefined ? null : (
        <box
          style={{
            position: "absolute",
            bottom: 0,
            right: viewport.width - page + RIGHT_MARGIN,
            height: 1,
            flexDirection: "row",
          }}
        >
          <text style={{ fg: THEME.primary }}>{marker}</text>
        </box>
      )}
    </box>
  );
}

export const Transcript = memo(TranscriptView);

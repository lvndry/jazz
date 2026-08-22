/**
 * The view model for the fullscreen interface.
 *
 * Components below the shell are pure functions of this structure.
 * `bridge.tsx` is the single place where live state becomes a frame, which
 * keeps layout assertions reproducible from data.
 *
 * Layout, fixed at every width:
 *
 *   header      1 row, never hidden
 *   transcript  flex, owns its own scrolling
 *   live zone   0–5 rows, grows upward, present only while work is in flight
 *   gap         1 row, so the live band never sits on the composer
 *   input       1–N rows, anchored to the bottom
 *   footer      1 row, anchored to the bottom
 *   overlay     floats above all of it, and must not disturb the transcript
 */

import type { FilePickerModel } from "./overlays/FilePicker";
import type { QuestionModel } from "./overlays/Question";
import type { TextPromptModel } from "./overlays/TextPrompt";

/**
 * Once the content column is at least this wide, leftover columns become a
 * short flush-right metadata strip. Below it the frame *is* the measure.
 */
export const PROSE_MEASURE = 88;

/** Timestamps and lane labels sit here; the rest of the surplus widens prose. */
export const METADATA_RESERVE = 20;

/** The live zone caps rather than grows, so the input never moves. */
export const LIVE_ZONE_MAX_ROWS = 5;

/** Below this the interface refuses to draw a partial frame. */
export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 12;

// ─── Blocks ──────────────────────────────────────────────────────────────────

/**
 * The transcript is an ordered list of blocks, not a stream of lines. The block
 * is the shared unit of scroll anchoring, collapse, copy-out, search-hit
 * attribution and persistence — which is what keeps a resize from losing the
 * reader's place, since the scroll anchor is a block id rather than a line
 * number.
 */
export type BlockId = string;

export interface BlockBase {
  readonly id: BlockId;
  readonly seq: number;
}

export interface UserBlock extends BlockBase {
  readonly kind: "user";
  readonly text: string;
  readonly at?: string;
}

export interface AgentBlock extends BlockBase {
  readonly kind: "agent";
  /** Raw markdown. Never pre-rendered ANSI: search, copy-out and persistence all read this. */
  readonly markdown: string;
  readonly streaming?: boolean;
}

export interface ReasoningBlock extends BlockBase {
  readonly kind: "reasoning";
  readonly text: string;
  readonly collapsed: boolean;
  readonly steps?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

/**
 * A settled tool call is a receipt: what it did and what came back. The
 * invocation, arguments, timing and full output live behind an expand key,
 * because once a tool has run those are no longer the interesting part.
 */
export interface ToolReceiptBlock extends BlockBase {
  readonly kind: "tool";
  readonly app: string;
  readonly summary: string;
  readonly status: "ok" | "failed" | "denied";
  /** Shown only on failure, with the remedy inline. */
  readonly reason?: string;
  readonly remedyKey?: string;
  readonly durationMs?: number;
  readonly detail?: string;
  readonly expanded?: boolean;
}

export interface NoticeBlock extends BlockBase {
  readonly kind: "notice";
  readonly text: string;
  readonly tone: "info" | "warn" | "error";
}

export interface DividerBlock extends BlockBase {
  readonly kind: "divider";
  readonly label: string;
}

/** A delegated subagent. Depth is a lane column, never indentation. */
export interface LaneBlock extends BlockBase {
  readonly kind: "lane";
  readonly name: string;
  readonly ask: string;
  readonly lane: number;
  readonly state: "running" | "done" | "failed";
  readonly result?: string;
  readonly steps?: number;
}

export type Block =
  | UserBlock
  | AgentBlock
  | ReasoningBlock
  | ToolReceiptBlock
  | NoticeBlock
  | DividerBlock
  | LaneBlock;

// ─── Header ──────────────────────────────────────────────────────────────────

export type ConnectorStatus = "live" | "renew" | "offline";

export interface Connector {
  readonly name: string;
  readonly status: ConnectorStatus;
}

/**
 * Four facts, one row. Identity carries version and cwd; the right-aligned
 * groups carry model, connector health, and context pressure.
 */
export interface HeaderModel {
  readonly version: string;
  readonly cwd: string;
  readonly model: string;
  readonly connectors: readonly Connector[];
  readonly contextUsed: number;
  readonly contextMax: number;
}

// ─── Live zone ───────────────────────────────────────────────────────────────

export interface LiveTool {
  readonly app: string;
  readonly operation: string;
  readonly elapsedMs: number;
  /** Phase offset so lanes do not animate in lockstep. */
  readonly phase: number;
}

export interface StepLine {
  readonly index: number;
  readonly total: number;
  readonly label: string;
}

export interface LiveModel {
  readonly tools: readonly LiveTool[];
  readonly hiddenTools: readonly string[];
  readonly step?: StepLine;
  /** House-voice waiting copy. Shown only before the first token lands. */
  readonly waiting?: string;
  readonly elapsedMs?: number;
  /** Monotonic tick driving the indicator. */
  readonly tick: number;
  /**
   * Rows the band occupies, as a high-water mark for the turn.
   *
   * Tools churn several times a second, and a band that shrank the moment one
   * finished would walk the input up and down under the user's hands. So the
   * adapter grows this to fit and only lets it fall after the run settles —
   * which keeps the input still *without* reserving the full cap for a single
   * tool call and leaving four blank rows.
   *
   * Temporal state belongs to the adapter, not the component: the region stays
   * a pure function of the model, so a frame is still reproducible from data.
   */
  readonly reservedRows: number;
}

// ─── Input, footer ───────────────────────────────────────────────────────────

export type Mode = "chat" | "plan" | "auto" | "safe" | "yolo";

export interface CommandSuggestion {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly source?: "skill";
}

export interface InputModel {
  readonly value: string;
  /** Slash-command picker, present only while the draft is a `/` prefix. */
  readonly commands?: {
    readonly items: readonly CommandSuggestion[];
    readonly selected: number;
  };
  /**
   * Code-point offset into `value` where the next typed character lands.
   * Defaults to the end when omitted, which is what every screen that does not
   * need real editing (samples, tests rendering a finished draft) wants.
   */
  readonly caret?: number;
  /**
   * The other end of the selection. Equal to `caret` (or omitted) when there
   * is no range. The painted highlight is the span between the two.
   */
  readonly anchor?: number;
  readonly placeholder: string;
  readonly queued: number;
  /** Busy chat turns queue Enter instead of resolving the active prompt. */
  readonly queueing?: boolean;
  /** Suppressed while a modal overlay owns the keyboard. */
  readonly disabled: boolean;
}

export interface FooterModel {
  readonly mode: Mode;
  readonly hints: readonly string[];
  /** Replaces hints for a beat — copy confirmation, not a key legend. */
  readonly notice?: string;
  readonly costUsd?: number;
  readonly elapsedMs?: number;
}

// ─── Overlays ────────────────────────────────────────────────────────────────

export interface ApprovalField {
  readonly label: string;
  readonly value: string;
}

/**
 * The most consequential object in the product: a calendar write or an outbound
 * message has no undo. It names the real account, shows every field that will
 * exist afterwards, states irreversibility in prose, and holds perfectly still.
 */
export interface ApprovalOverlay {
  readonly kind: "approval";
  readonly app: string;
  readonly action: string;
  readonly account: string;
  readonly fields: readonly ApprovalField[];
  readonly consequence: string;
  readonly fieldOffset?: number;
  readonly alwaysLabel: string;
  /** True once the arming delay has passed; before that only deny is accepted. */
  readonly armed: boolean;
}

export interface SearchHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly when: string;
  readonly line: string;
  readonly matchStart: number;
  readonly matchLength: number;
  readonly current: boolean;
}

export interface SearchOverlay {
  readonly kind: "search";
  readonly query: string;
  readonly scope: "session" | "all";
  readonly hits: readonly SearchHit[];
  readonly selected: number;
}

export type Overlay =
  ApprovalOverlay | SearchOverlay | QuestionModel | TextPromptModel | FilePickerModel;

// ─── The frame ───────────────────────────────────────────────────────────────

export type Focus = "input" | "transcript";

export interface ViewModel {
  readonly header: HeaderModel;
  readonly blocks: readonly Block[];
  readonly live: LiveModel;
  /** True while a turn can still be interrupted, including streaming-only work. */
  readonly runActive?: boolean;
  readonly input: InputModel;
  readonly footer: FooterModel;
  readonly overlay?: Overlay;
  readonly focus: Focus;
  /** Set while the reader is scrolled away from the live edge. */
  readonly newBelow?: number;
}

/** Terminal geometry, resolved once per frame. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Running text takes the content column; a short strip on the right is metadata. */
export function measureFor(width: number): { prose: number; metadata: number } {
  const content = Math.max(MIN_WIDTH, width) - 4;
  const metadata = Math.min(METADATA_RESERVE, Math.max(0, content - PROSE_MEASURE));
  return { prose: content - metadata, metadata };
}

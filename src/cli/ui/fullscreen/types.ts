/**
 * The view model for the fullscreen interface.
 *
 * Every component below the shell is a pure function of this structure. Nothing
 * in `fullscreen/` reads the store, the clock, or the environment directly —
 * the adapter in `view-model.ts` is the single place where live state becomes a
 * frame. That is what makes the layout testable: a frame is reproducible from
 * data alone, so an assertion about the rendered characters is an assertion
 * about the design.
 *
 * Layout, fixed at every width:
 *
 *   header      1 row, never hidden
 *   transcript  flex, owns its own scrolling
 *   live zone   0–5 rows, grows upward, present only while work is in flight
 *   input       1–N rows, anchored to the bottom
 *   footer      1 row, anchored to the bottom
 *   overlay     floats above all of it, and must not disturb the transcript
 */

/** Prose is measured, not stretched: past ~90 characters the eye loses the line. */
export const PROSE_MEASURE = 88;

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
 * Four facts, one row. Version, cwd, reasoning level and raw token counts moved
 * behind a key: the header is not an inventory, it is the things that change or
 * that you would act on.
 */
export interface HeaderModel {
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

export type Mode = "chat" | "plan" | "auto" | "yolo";

export interface InputModel {
  readonly value: string;
  readonly placeholder: string;
  readonly queued: number;
  /** Suppressed while a modal overlay owns the keyboard. */
  readonly disabled: boolean;
}

export interface FooterModel {
  readonly mode: Mode;
  readonly hints: readonly string[];
  readonly costUsd?: number;
  readonly elapsedMs?: number;
  readonly personality: "straight" | "house" | "loose";
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

export type Overlay = ApprovalOverlay | SearchOverlay;

// ─── The frame ───────────────────────────────────────────────────────────────

export type Focus = "input" | "transcript";

export interface ViewModel {
  readonly header: HeaderModel;
  readonly blocks: readonly Block[];
  readonly live: LiveModel;
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

/** Running text is measured; the surplus becomes a flush-right metadata column. */
export function measureFor(width: number): { prose: number; metadata: number } {
  const content = Math.max(MIN_WIDTH, width) - 4;
  const prose = Math.min(PROSE_MEASURE, content);
  return { prose, metadata: Math.max(0, content - prose) };
}

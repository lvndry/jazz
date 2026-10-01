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
 *   live zone   0–12 rows, grows upward, present only while work is in flight
 *   gap         1 row, so the live band never sits on the composer
 *   input       1–N rows, anchored to the bottom
 *   subagents   0–N rows, present only while the turn has delegated work
 *   footer      1 row, anchored to the bottom
 *   overlay     floats above all of it, and must not disturb the transcript
 */

import type { TerminalReport } from "@jazz/core/interfaces/terminal";
import type { TodoSnapshotItem } from "../activity-state";
import type { ApprovalCommand, ApprovalDiff } from "../models/approval";
import type { ToolReceipt } from "../models/receipt";
import type { SubagentStatus } from "../subagent-runs";
import type { SuggestionPrefix } from "../suggestion-menu";
import type { FilePickerModel } from "./overlays/FilePicker";
import type { QuestionModel } from "./overlays/Question";
import type { TextPromptModel } from "./overlays/TextPrompt";
import type { RetryBand } from "../models/retry";
/**
 * The live zone caps rather than grows, so the input never moves.
 *
 * High enough that a typical todo list (5-10 items) renders in full rather
 * than windowed behind a "+N more" line — the checklist is most useful when
 * it's the whole plan, not a peephole onto it.
 */
export const LIVE_ZONE_MAX_ROWS = 12;

/** Dense cards shed spacing below these dimensions. */
export const COMPACT_WIDTH = 60;
export const COMPACT_HEIGHT = 12;

/**
 * Smallest viewport where the conversation and approval controls remain usable.
 * At this floor, the transcript still gets a row and approval actions and
 * detail-navigation keys fit in the compact approval legend.
 */
export const MIN_WIDTH = 32;
export const MIN_HEIGHT = 10;

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
  /** How many reasoning steps a folded line stands for. */
  readonly steps?: number;
  /** Total once settled. A live block has none: the live zone ticks the elapsed time. */
  readonly durationMs?: number;
  readonly tokens?: number;
  /** The model is still thinking: only the newest lines show. */
  readonly live?: boolean;
  /** False when the model thought without returning text, so there is nothing for ctrl+r to open. */
  readonly readable?: boolean;
}

/**
 * A settled tool call is a receipt: the app, the args it used, and a snippet
 * of what came back. Timing and the full output live behind an expand key.
 */
export interface ToolReceiptBlock extends BlockBase, ToolReceipt {
  readonly kind: "tool";
  readonly expanded?: boolean;
}

export interface NoticeBlock extends BlockBase {
  readonly kind: "notice";
  readonly text: string;
  /** `receipt` closes a turn with its totals; `info` is system or command output, never the agent. */
  readonly tone: "info" | "warn" | "error" | "receipt";
}

/**
 * A slash command's answer, kept as data so it reads as jazz speaking: the
 * command's name in the label column, aligned rows under the value column.
 */
export interface ReportBlock extends BlockBase {
  readonly kind: "report";
  readonly report: TerminalReport;
}

export interface DividerBlock extends BlockBase {
  readonly kind: "divider";
  readonly label: string;
}

/** A turn the person stopped: how long it ran, what finished, and what did not. */
export interface StoppedBlock extends BlockBase {
  readonly kind: "stopped";
  readonly elapsedMs: number;
  readonly done: readonly string[];
  readonly notDone: readonly string[];
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
  | ReportBlock
  | DividerBlock
  | StoppedBlock
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
  readonly localHost?: string;
  /** Reasoning effort, when the model has one; shown beside the model in the composer. */
  readonly reasoning?: string;
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
  /** When set, the operation is source and takes the three syntax roles. */
  readonly language?: string;
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
  /**
   * The full todo checklist when the agent is managing one. Rendered as a
   * windowed panel in the band (active/pending items first, `+N more` when it
   * does not fit) so the plan is visible without breaking the fixed-height band.
   */
  readonly todoList?: readonly TodoSnapshotItem[];
  /** House-voice waiting copy. Shown only before the first token lands. */
  readonly waiting?: string;
  readonly elapsedMs?: number;
  /**
   * Elapsed time for the open reasoning region, if one is running.
   * Lives here rather than on a transcript Block so a clock update cannot
   * rewrite block identity and defeat wrap memoization.
   */
  readonly reasoningElapsedMs?: number;
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
  /** A model call waiting to be tried again. Takes the band's top rows while it lasts. */
  readonly retry?: RetryBand;
}

// ─── Sub-agents ──────────────────────────────────────────────────────────────

export interface SubagentListItem {
  readonly id: string;
  readonly label: string;
  readonly status: SubagentStatus;
  /** Newest line of output, so a row says what the agent is doing, not just that it is. */
  readonly activity: string;
  readonly elapsedMs: number;
}

/**
 * This turn's sub-agents, listed under the composer. `selected` is set only while
 * the list has the keyboard; `inspecting` names the one whose log fills the
 * transcript.
 */
export interface SubagentListModel {
  readonly items: readonly SubagentListItem[];
  readonly selected?: number;
  readonly inspecting?: string;
}

// ─── Input, footer ───────────────────────────────────────────────────────────

export type Mode = "chat" | "plan" | "auto" | "safe" | "yolo";

export interface CommandSuggestion {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly source?: "skill" | "mcp-prompt" | "plugin";
}

export interface InputModel {
  readonly value: string;
  /** Slash-command picker, present only while the draft is a `/` prefix. */
  readonly commands?: {
    readonly items: readonly CommandSuggestion[];
    readonly selected: number;
    /**
     * Sigil the suggestions complete. Slash commands and `@` file mentions
     * share this menu, and the rows have to show the one being typed.
     */
    readonly prefix?: SuggestionPrefix;
    /** What is typed after the sigil; its letters are bold in each name that contains them. */
    readonly query?: string;
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
  /** Messages waiting for the current turn to finish. Empty when idle. */
  readonly queued: readonly string[];
  /** Busy chat turns queue Enter instead of resolving the active prompt. */
  readonly queueing?: boolean;
  /** Suppressed while a modal overlay owns the keyboard. */
  readonly disabled: boolean;
  /** Muted, right-aligned on the composer's first line when it fits: `model · reasoning`. */
  readonly meta?: string;
}

export interface FooterModel {
  readonly mode: Mode;
  readonly hints: readonly string[];
  /** Replaces hints for a beat — copy confirmation, not a key legend. */
  readonly notice?: string;
  /** Session-cumulative billed prompt tokens. */
  readonly promptTokens?: number;
  /** Session-cumulative billed completion tokens. */
  readonly completionTokens?: number;
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
/** The three answers the approval card offers, in the order ← → walk them. */
export type ApprovalChoice = "accept" | "always" | "reject";

export interface ApprovalOverlay {
  readonly kind: "approval";
  readonly app: string;
  readonly action: string;
  readonly account: string;
  readonly fields: readonly ApprovalField[];
  readonly consequence: string;
  readonly fieldOffset?: number;
  /** True after Ctrl+O: long fields wrap in full instead of the 120-cell preview. */
  readonly expanded?: boolean;
  readonly alwaysLabel: string;
  /** Restricted HTTP calls can only be approved individually. */
  readonly allowAlways?: boolean;
  /** Which of the three controls enter confirms; accept until ← → move it. */
  readonly choice?: ApprovalChoice;
  /** True once the arming delay has passed; before that only deny is accepted. */
  readonly armed: boolean;
  /** The consequence in two or three words for the title row: `can't be unsent`. */
  readonly headline?: string;
  /** The verbs on the two controls: `send` / `don't send`. */
  readonly acceptLabel?: string;
  readonly rejectLabel?: string;
  /** The measured effect, shown as one more field: `removes  214 files, 1.3 GB`. */
  readonly impact?: ApprovalField;
  /** A shell command, shown as code in its own band rather than as a field value. */
  readonly command?: ApprovalCommand;
  /** A file change, shown as tinted rows with `+N −M` on the title row. */
  readonly diff?: ApprovalDiff;
  readonly diffLanguage?: string;
  /** A caution that must be read before accepting; shown even when the headline replaces the tool's prose. */
  readonly warning?: string;
  /** The argument `e` rewrites before accepting (`command`), when the tool allows it. */
  readonly editableArg?: string;
}

export interface SearchHit {
  readonly agentId: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly when: string;
  readonly line: string;
  readonly matchStart: number;
  readonly matchLength: number;
  readonly current: boolean;
}

export interface SearchOverlay {
  readonly kind: "search";
  readonly query: string;
  /** Caret offset into `query`, in characters. */
  readonly caret: number;
  readonly scope: "conversation" | "all";
  readonly hits: readonly SearchHit[];
  readonly selected: number;
}

/** One theme and variant in the picker, drawn with its own colours. */
export interface ThemePickerRow {
  /** `name:variant`, what `previewTheme` and `applyTheme` take. */
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly variant: "dark" | "light";
  readonly swatches: readonly string[];
  readonly current: boolean;
}

export interface ThemePickerModel {
  readonly kind: "theme";
  readonly rows: readonly ThemePickerRow[];
  readonly selected: number;
}

export type Overlay =
  | ApprovalOverlay
  | SearchOverlay
  | QuestionModel
  | TextPromptModel
  | FilePickerModel
  | ThemePickerModel;

// ─── The frame ───────────────────────────────────────────────────────────────

export type Focus = "input" | "transcript";

export interface ViewModel {
  /** Conversation/child identity for source and view lifecycle. */
  readonly documentId: string;
  readonly header: HeaderModel;
  readonly blocks: readonly Block[];
  readonly live: LiveModel;
  /** True while a turn can still be interrupted, including streaming-only work. */
  readonly runActive?: boolean;
  readonly input: InputModel;
  readonly footer: FooterModel;
  readonly subagents?: SubagentListModel;
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

/** Available conversation cells after the two-cell gutter and right padding. */
export function measureFor(width: number): { prose: number } {
  return { prose: Math.max(1, width - 4) };
}

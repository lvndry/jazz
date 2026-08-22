import type React from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import type { StreamKind } from "./adapters/terminal-output-adapter";
import type { OutputEntry, PromptState } from "./types";

/** Accepts single entry or batch; returns first id when available. */
type PrintOutputHandler = (entry: OutputEntry | readonly OutputEntry[]) => string;

type UpdateOutputHandler = (id: string, patch: OutputEntry) => void;

type StreamingHandler = {
  appendStream: (kind: StreamKind, delta: string) => void;
  finalizeStream: () => void;
};

/** Handler for mode switch requests (e.g., Shift+Tab toggles safe/yolo) */
type ModeSwitchHandler = (mode: "safe" | "yolo") => void;

const MAX_PENDING_OUTPUT_QUEUE = 2000;

/** Set when we've logged the queue-full warning once to avoid spam */
let _hasWarnedQueueFull = false;

interface ExpandableDiffPayload {
  readonly fullDiff: string;
  readonly timestamp: number;
}

/**
 * Kinds of ephemeral live region. Each kind has its own UI label and default
 * size; "reasoning" is the only kind that supports Ctrl-R expansion.
 */
export type EphemeralKind = "reasoning" | "subagent";

export type EphemeralRegionId = string;

/**
 * A bounded live region rendered above the prompt while an in-flight activity
 * (the model thinking, a subagent working) is producing output. The region
 * shows only the last N lines of the activity; on completion it is removed
 * and a one-line summary is emitted into scrollback.
 */
export interface EphemeralRegion {
  readonly id: EphemeralRegionId;
  readonly kind: EphemeralKind;
  readonly label: string;
  readonly startedAt: number;
  readonly tail: readonly string[];
  readonly maxLines: number;
}

/**
 * Snapshot of a collapsed reasoning block, available for Ctrl-R expansion.
 * Collapsed blocks accumulate in a bounded stack — each Ctrl-R press pops
 * and expands the most recent unexpanded block, so earlier reasoning from
 * a multi-step turn stays recoverable instead of being overwritten.
 */
export interface ExpandableReasoning {
  readonly fullText: string;
  readonly label: string;
  readonly durationMs: number;
  readonly tokens?: number;
  /** Output entry to rewrite in place. Missing when the block was never logged. */
  readonly entryId?: string;
}

/** Upper bound on retained collapsed-reasoning blocks. */
const MAX_EXPANDABLE_REASONING = 20;

/** Upper bound on recallable sent-message history. */
const MAX_INPUT_HISTORY = 100;

/** Caller-supplied summary when collapsing a region. */
export interface CollapseEphemeralSummary {
  /** One-line static entry to emit into scrollback (omit to skip). */
  readonly line?: string;
  /** Full text to keep around for Ctrl-R expansion (reasoning only). */
  readonly fullText?: string;
  readonly durationMs: number;
  readonly tokens?: number;
}

/**
 * Persistent run-level stats surfaced in the status footer.
 *
 * All fields are optional so partial information renders gracefully —
 * the footer simply omits any field that hasn't been populated yet.
 * Most fields are session-totals, updated after each LLM round-trip.
 */
/**
 * A pending approval, reduced to what an interface needs to render a decision.
 * Deliberately not the full `ApprovalRequest`: the store should not depend on
 * the tools layer, and the resume callback is not the UI's business.
 */
export type ConnectorStatus = "live" | "renew" | "offline";

/**
 * A menu the app is waiting on, published as data rather than as a rendered tree.
 *
 * `setCustomView` hands the UI a React element built with Ink components, which
 * only the Ink renderer can paint — so a second renderer sees an opaque node and
 * can do nothing useful with it. Publishing the *intent* instead lets each
 * renderer draw its own version, which is the only way two renderers can share
 * a flow.
 */
export interface ActiveMenuOption {
  readonly label: string;
  readonly value: string;
}

export interface ActiveMenuRequirement {
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly remedy?: string;
}

export interface ActiveAgentChoice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly description?: string;
  readonly lastUsed?: boolean;
}

export interface ActiveWizardMenu {
  readonly kind: "menu";
  readonly title?: string;
  readonly options: readonly ActiveMenuOption[];
  readonly requirements?: readonly ActiveMenuRequirement[];
  readonly tip?: string;
  readonly onSelect: (value: string) => void;
  readonly onExit: () => void;
}

export interface ActiveAgentMenu {
  readonly kind: "agents";
  readonly title: string;
  readonly action: string;
  readonly agents: readonly ActiveAgentChoice[];
  readonly onSelect: (value: string) => void;
  readonly onExit: () => void;
  readonly browse?: boolean;
}

export type ActiveMenu = ActiveWizardMenu | ActiveAgentMenu;

export interface PendingApproval {
  readonly toolName: string;
  readonly executeToolName: string;
  readonly message: string;
  readonly args: Record<string, unknown>;
  readonly previewDiff?: string;
}

export interface RunStats {
  /** Display name of the active model (e.g. "claude-sonnet-4-5"). */
  readonly model?: string;
  /** Provider name (e.g. "anthropic", "openai"). */
  readonly provider?: string;
  /** Tokens currently in the context window for this conversation. */
  readonly tokensInContext?: number;
  /** Model's maximum context window in tokens. */
  readonly maxContextTokens?: number;
  /** Running total cost in USD across this session. */
  readonly costUSD?: number;
}

export class UIStore {
  // Output handlers
  private printOutputHandler: PrintOutputHandler | null = null;
  private updateOutputHandler: UpdateOutputHandler | null = null;
  private clearOutputsHandler: (() => void) | null = null;
  private pinnedReasoningIds = new Set<EphemeralRegionId>();
  private streamingHandler: StreamingHandler | null = null;
  private pendingOutputQueue: OutputEntry[] = [];
  private _pendingClear = false;
  private pendingOutputIdCounter = 0;

  /** Coalesce rapid printOutput calls; flush on next microtask */
  private outputBatch: OutputEntry[] = [];
  private batchFlushScheduled = false;

  // Expandable diff for Ctrl+O expansion
  private expandableDiff: ExpandableDiffPayload | null = null;

  // Mode switch handler (set by chat service)
  private modeSwitchHandler: ModeSwitchHandler | null = null;
  // Track current mode for toggle behavior (safe = false, yolo = true)
  private currentModeIsYolo = false;

  // Snapshots (kept in sync so late-registering components can hydrate)
  private promptSnapshot: PromptState | null = null;
  private activitySnapshot: ActivityState = { phase: "idle" };
  private workingDirectorySnapshot: string | null = null;
  private runStatsSnapshot: RunStats = {};
  // Session-wide cumulative cost in USD. Every renderer (main agent and each
  // sub-agent) adds its own per-turn cost here so the footer total reflects
  // aggregate spend, not just the orchestrator's. Reset per session.
  private sessionCostUSD = 0;
  private ephemeralRegionsSnapshot: readonly EphemeralRegion[] = [];
  private expandableReasoningSnapshot: ExpandableReasoning | null = null;
  private expandableReasoningStack: ExpandableReasoning[] = [];
  private inputHistory: string[] = [];
  private messageQueueSnapshot: readonly string[] = [];
  private chatBusySnapshot: boolean = false;
  private customViewSnapshot: React.ReactNode | null = null;

  // Insertion-ordered map of live ephemeral regions, keyed by id.
  private ephemeralRegions: Map<EphemeralRegionId, EphemeralRegion> = new Map();
  private ephemeralIdCounter = 0;

  // React state setters (registered by island components)
  private promptSetter: ((prompt: PromptState | null) => void) | null = null;
  private activitySetter: ((activity: ActivityState) => void) | null = null;
  private workingDirectorySetter: ((wd: string | null) => void) | null = null;
  private runStatsSetter: ((stats: RunStats) => void) | null = null;
  private ephemeralRegionsSetter: ((regions: readonly EphemeralRegion[]) => void) | null = null;
  private expandableReasoningSetter: ((value: ExpandableReasoning | null) => void) | null = null;
  private messageQueueSetter: ((queue: readonly string[]) => void) | null = null;
  private chatBusySetter: ((busy: boolean) => void) | null = null;
  private customViewSetter: ((view: React.ReactNode | null) => void) | null = null;
  private modeToastSetter: ((message: string | null) => void) | null = null;
  private modeSetter: ((isYolo: boolean) => void) | null = null;
  private rendererFallbackHandler: (() => void) | null = null;

  // ── Public API (called by consumers) ──────────────────────────────

  private flushOutputBatch = (): void => {
    this.batchFlushScheduled = false;
    this.doFlushBatch();
  };

  private doFlushBatch(): void {
    if (!this.printOutputHandler || this.outputBatch.length === 0) return;
    const batch = this.outputBatch;
    this.outputBatch = [];
    if (batch.length === 1) {
      this.printOutputHandler(batch[0]!);
    } else if (batch.length > 1) {
      this.printOutputHandler(batch);
    }
  }

  /**
   * Synchronously flush any pending output batch. Use before setActivity during
   * streaming so output + activity land in same React tick (reduces flicker).
   */
  flushOutputBatchNow(): void {
    if (this.batchFlushScheduled) {
      this.batchFlushScheduled = false;
    }
    this.doFlushBatch();
  }

  printOutput = (entry: OutputEntry): string => {
    const id = entry.id ?? `queued-output-${++this.pendingOutputIdCounter}`;
    const entryWithId = entry.id ? entry : { ...entry, id };

    if (!this.printOutputHandler) {
      if (this.pendingOutputQueue.length < MAX_PENDING_OUTPUT_QUEUE) {
        this.pendingOutputQueue.push(entryWithId);
      } else {
        if (!_hasWarnedQueueFull) {
          _hasWarnedQueueFull = true;
          console.warn(
            `[jazz] Output queue full (${MAX_PENDING_OUTPUT_QUEUE}); some output may be dropped until UI is ready.`,
          );
        }
      }
      return id;
    }

    this.outputBatch.push(entryWithId);
    if (!this.batchFlushScheduled) {
      this.batchFlushScheduled = true;
      queueMicrotask(this.flushOutputBatch);
    }
    return id;
  };

  setPrompt = (prompt: PromptState | null): void => {
    this.promptSnapshot = prompt;
    // Do NOT eagerly erase Ink's frame here. `Ink.clear()` erases the frame
    // and then re-syncs log-update to believe those lines are still painted,
    // so the very next render erases the same line count a second time —
    // chewing (frameHeight - 1) lines of settled scrollback and overwriting
    // them with the next entry. Ink's own render already fully erases the
    // previous frame before repainting, so a shrinking prompt cleans up.
    if (this.promptSetter) {
      this.promptSetter(prompt);
    }
  };

  setActivity = (activity: ActivityState): void => {
    if (isActivityEqual(this.activitySnapshot, activity)) {
      return;
    }
    this.activitySnapshot = activity;
    if (this.activitySetter) {
      this.activitySetter(activity);
    }
  };

  setWorkingDirectory = (workingDirectory: string | null): void => {
    this.workingDirectorySnapshot = workingDirectory;
    if (this.workingDirectorySetter) {
      this.workingDirectorySetter(workingDirectory);
    }
  };

  /**
   * Merge a partial RunStats update into the snapshot. Callers can pass any
   * subset of fields — anything they omit keeps its prior value. Useful for
   * incremental updates (e.g. tokens-in-context after every LLM call,
   * costUSD only after we've resolved pricing).
   */
  resetRunStats = (initial: RunStats = {}): void => {
    this.sessionCostUSD = 0;
    this.runStatsSnapshot = initial;
    if (this.runStatsSetter) {
      this.runStatsSetter(initial);
    }
  };

  /**
   * Add a run's cost to the session-wide total and publish it to the footer.
   * Called by every renderer (main agent and sub-agents) as each turn's cost
   * resolves, so the displayed total aggregates all spend rather than being
   * clobbered by whichever run completed last.
   */
  addSessionCostUSD = (deltaUSD: number): void => {
    if (!deltaUSD) return;
    this.sessionCostUSD += deltaUSD;
    this.updateRunStats({ costUSD: this.sessionCostUSD });
  };

  updateRunStats = (patch: Partial<RunStats>): void => {
    const next: RunStats = { ...this.runStatsSnapshot, ...patch };
    let changed = false;
    for (const k of Object.keys(patch) as (keyof RunStats)[]) {
      if (this.runStatsSnapshot[k] !== next[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.runStatsSnapshot = next;
    if (this.runStatsSetter) {
      this.runStatsSetter(next);
    }
  };

  setCustomView = (view: React.ReactNode | null): void => {
    this.customViewSnapshot = view;
    this.customViewSetter?.(view);
  };

  /**
   * Stack of active interrupt handlers, ordered oldest-first. Each call to
   * `setInterruptHandler(handler)` with a non-null handler pushes; calling with
   * null pops. The UI always observes the top of the stack as the active
   * handler. This lets nested agent runs (a subagent invoked as a tool by a
   * main agent) each register their own handler without overwriting the
   * outer scope's: when the inner run finishes and pops, the outer run's
   * handler is restored automatically.
   */
  private interruptHandlerStack: Array<() => void> = [];
  private interruptHandlerSetter: ((handler: (() => void) | null) => void) | null = null;

  setInterruptHandler = (handler: (() => void) | null): void => {
    if (handler === null) {
      this.interruptHandlerStack.pop();
    } else {
      this.interruptHandlerStack.push(handler);
    }
    const top = this.interruptHandlerStack[this.interruptHandlerStack.length - 1] ?? null;
    this.interruptHandlerSetter?.(top);
  };

  /**
   * Append a message to the chat message queue. Each call is one entry —
   * the UI renders entries stacked, one per line. On flush they're joined
   * with `\n` and sent to the agent as a single combined turn.
   */
  appendToQueue = (text: string): void => {
    if (text.length === 0) return;
    const next = [...this.messageQueueSnapshot, text];
    this.messageQueueSnapshot = next;
    this.messageQueueSetter?.(next);
  };

  /**
   * Read the joined queue contents without clearing. Entries are joined with
   * `\n` so the result is the exact string that would be sent to the agent
   * if this queue were drained right now.
   */
  peekQueue = (): string => this.messageQueueSnapshot.join("\n");

  /** Read the queue (joined as a single string) and clear it. */
  takeQueue = (): string => {
    if (this.messageQueueSnapshot.length === 0) return "";
    const value = this.messageQueueSnapshot.join("\n");
    this.messageQueueSnapshot = [];
    this.messageQueueSetter?.([]);
    return value;
  };

  clearQueue = (): void => {
    if (this.messageQueueSnapshot.length === 0) return;
    this.messageQueueSnapshot = [];
    this.messageQueueSetter?.([]);
  };

  setChatBusy = (busy: boolean): void => {
    if (this.chatBusySnapshot === busy) return;
    this.chatBusySnapshot = busy;
    this.chatBusySetter?.(busy);
  };

  setExpandableDiff = (fullDiff: string): void => {
    this.expandableDiff = { fullDiff, timestamp: Date.now() };
  };

  getExpandableDiff = (): ExpandableDiffPayload | null => {
    return this.expandableDiff;
  };

  clearExpandableDiff = (): void => {
    this.expandableDiff = null;
  };

  // ── Mode switching ─────────────────────────────────────────────

  registerModeSwitchHandler = (handler: ModeSwitchHandler | null): void => {
    this.modeSwitchHandler = handler;
  };

  requestModeSwitch = (mode: "safe" | "yolo"): void => {
    if (this.modeSwitchHandler) {
      this.modeSwitchHandler(mode);
    }
  };

  toggleMode = (): void => {
    const nextMode = this.currentModeIsYolo ? "safe" : "yolo";
    this.currentModeIsYolo = !this.currentModeIsYolo;
    this.modeSetter?.(this.currentModeIsYolo);
    this.requestModeSwitch(nextMode);
  };

  setModeIsYolo = (isYolo: boolean): void => {
    this.currentModeIsYolo = isYolo;
    this.modeSetter?.(isYolo);
  };

  getModeIsYolo = (): boolean => this.currentModeIsYolo;

  /**
   * Subscribe the footer (or any island) to approval-mode changes so the
   * current safe/yolo state stays persistently visible, not just in the
   * 2-second toast.
   */
  registerModeSetter = (setter: ((isYolo: boolean) => void) | null): void => {
    this.modeSetter = setter;
    setter?.(this.currentModeIsYolo);
  };

  registerModeToastSetter = (setter: ((message: string | null) => void) | null): void => {
    this.modeToastSetter = setter;
  };

  showModeToast = (message: string): void => {
    this.modeToastSetter?.(message);
  };

  // ── Ephemeral live regions ────────────────────────────────────────

  private publishEphemeralRegions(): void {
    this.ephemeralRegionsSnapshot = Array.from(this.ephemeralRegions.values());
    this.ephemeralRegionsSetter?.(this.ephemeralRegionsSnapshot);
  }

  private setExpandableReasoning(value: ExpandableReasoning | null): void {
    this.expandableReasoningSnapshot = value;
    this.expandableReasoningSetter?.(value);
  }

  /**
   * Open a new ephemeral live region. Returns the region's id, which the
   * caller must hold onto for subsequent appendEphemeral / collapseEphemeral
   * calls. Multiple regions may be open at once (e.g. parallel subagents).
   */
  openEphemeral = (kind: EphemeralKind, label: string, maxLines: number): EphemeralRegionId => {
    const id = `eph-${++this.ephemeralIdCounter}-${Date.now()}`;
    this.ephemeralRegions.set(id, {
      id,
      kind,
      label,
      startedAt: Date.now(),
      tail: [],
      maxLines,
    });
    this.publishEphemeralRegions();
    return id;
  };

  /**
   * Append text to a live region. Splits incoming text on newlines, merges
   * the first chunk into the previous line (for delta-style streaming), and
   * keeps only the last `maxLines` lines.
   */
  appendEphemeral = (id: EphemeralRegionId, text: string): void => {
    if (text.length === 0) return;
    const region = this.ephemeralRegions.get(id);
    if (!region) return;

    const incoming = text.split("\n");
    const merged = [...region.tail];
    if (merged.length > 0 && incoming.length > 0) {
      merged[merged.length - 1] = (merged[merged.length - 1] ?? "") + (incoming.shift() ?? "");
    }
    for (const line of incoming) merged.push(line);

    const trimmed =
      merged.length > region.maxLines ? merged.slice(merged.length - region.maxLines) : merged;

    this.ephemeralRegions.set(id, { ...region, tail: trimmed });
    this.publishEphemeralRegions();
  };

  /**
   * Collapse a live region. Emits an optional one-line static entry into
   * scrollback and removes the region. For reasoning regions, captures the
   * full text into the expandableReasoning slot so Ctrl-R can re-emit it.
   */
  collapseEphemeral = (id: EphemeralRegionId, summary: CollapseEphemeralSummary): void => {
    const region = this.ephemeralRegions.get(id);
    if (!region) return;

    this.ephemeralRegions.delete(id);
    this.publishEphemeralRegions();

    const capturedText = summary.fullText?.trim() || region.tail.join("\n").trim();
    const pinned = this.pinnedReasoningIds.delete(id);

    if (region.kind === "reasoning" && capturedText.length > 0) {
      const entryId = `reasoning-${id}`;
      const seconds = (summary.durationMs / 1000).toFixed(1);
      this.printOutput({
        id: entryId,
        type: "streamContent",
        message: pinned
          ? `*${region.label} · ${seconds}s*\n\n${capturedText}`
          : (summary.line ?? `${region.label} · ${seconds}s · ctrl+r to expand`),
        meta: {
          kind: "reasoning",
          collapsed: !pinned,
          fullText: capturedText,
          durationMs: summary.durationMs,
          label: region.label,
        },
        timestamp: new Date(),
      });
      this.flushOutputBatchNow();
      this.pushExpandableReasoning({
        fullText: capturedText,
        label: region.label,
        durationMs: summary.durationMs,
        entryId,
        ...(summary.tokens !== undefined && { tokens: summary.tokens }),
      });
      return;
    }

    if (summary.line) {
      this.printOutput({
        type: "log",
        message: summary.line,
        timestamp: new Date(),
      });
    }
  };

  /** Record a sent chat message for ↑/↓ recall. Skips consecutive duplicates. */
  pushInputHistory = (message: string): void => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    if (this.inputHistory.at(-1) === trimmed) return;
    this.inputHistory.push(trimmed);
    if (this.inputHistory.length > MAX_INPUT_HISTORY) {
      this.inputHistory.shift();
    }
  };

  getInputHistory = (): readonly string[] => this.inputHistory;

  private pushExpandableReasoning(value: ExpandableReasoning): void {
    this.expandableReasoningStack.push(value);
    if (this.expandableReasoningStack.length > MAX_EXPANDABLE_REASONING) {
      this.expandableReasoningStack.shift();
    }
    this.setExpandableReasoning(value);
  }

  /**
   * Collapse every open region — used on errors, interrupts, and /clear so
   * panels don't get stuck. Emits no per-region summary, but open reasoning
   * regions are preserved into the expandable stack (their visible tail is
   * the best content available here — the full text lives in the renderer),
   * so an interrupt doesn't silently destroy in-flight reasoning.
   */
  collapseAllEphemeral = (): void => {
    if (this.ephemeralRegions.size === 0) return;
    for (const region of this.ephemeralRegions.values()) {
      if (region.kind !== "reasoning") continue;
      const fullText = region.tail.join("\n").trim();
      if (fullText.length === 0) continue;
      this.pushExpandableReasoning({
        fullText,
        label: region.label,
        durationMs: Date.now() - region.startedAt,
      });
    }
    this.ephemeralRegions.clear();
    this.publishEphemeralRegions();
  };

  /**
   * Keep the live reasoning panel expanded when it settles, so Ctrl+R during
   * a run does not wait for the turn to finish and then dump the thought
   * under the answer.
   */
  pinOpenReasoning = (): boolean => {
    let pinned = false;
    for (const region of this.ephemeralRegions.values()) {
      if (region.kind !== "reasoning") continue;
      this.pinnedReasoningIds.add(region.id);
      pinned = true;
    }
    return pinned;
  };

  /**
   * Expand the most recently collapsed reasoning *in the place it was
   * thought*. Appending it as a new log line put the thought under the
   * answer, which is the opposite of the order it happened.
   */
  expandLastReasoning = (): boolean => {
    const value = this.expandableReasoningStack.pop();
    if (value === undefined) return this.pinOpenReasoning();
    const seconds = (value.durationMs / 1000).toFixed(1);
    const entry: OutputEntry = {
      type: "streamContent",
      message: `*${value.label} · ${seconds}s*\n\n${value.fullText}`,
      meta: {
        kind: "reasoning",
        collapsed: false,
        fullText: value.fullText,
        durationMs: value.durationMs,
        label: value.label,
      },
      timestamp: new Date(),
      ...(value.entryId === undefined ? {} : { id: value.entryId }),
    };
    if (value.entryId !== undefined && this.updateOutputHandler !== null) {
      this.updateOutputHandler(value.entryId, entry);
    } else {
      this.printOutput(entry);
      this.flushOutputBatchNow();
    }
    this.setExpandableReasoning(this.expandableReasoningStack.at(-1) ?? null);
    return true;
  };

  appendStream = (kind: StreamKind, delta: string): void => {
    if (delta.length === 0) return;
    // Streaming bypasses the printOutput batch — deltas go straight in.
    // Flush any pending non-streaming batch first to preserve ordering.
    this.flushOutputBatchNow();
    if (!this.streamingHandler) return;
    this.streamingHandler.appendStream(kind, delta);
  };

  finalizeStream = (): void => {
    this.flushOutputBatchNow();
    if (!this.streamingHandler) return;
    this.streamingHandler.finalizeStream();
  };

  clearOutputs = (): void => {
    // Discard any pending batched outputs to prevent race condition where
    // a queued microtask flushes after clear
    this.outputBatch = [];
    this.batchFlushScheduled = false;

    // Reasoning from before the clear is stale context — drop it so Ctrl+R
    // can't resurrect output the user just wiped.
    this.expandableReasoningStack = [];
    this.pinnedReasoningIds.clear();
    this.setExpandableReasoning(null);

    if (!this.clearOutputsHandler) {
      this._pendingClear = true;
      this.pendingOutputQueue.length = 0;
      return;
    }
    this.clearOutputsHandler();
  };

  // ── Registration methods (called by island components) ────────────

  private activeMenuSnapshot: ActiveMenu | null = null;
  private activeMenuSetter: ((menu: ActiveMenu | null) => void) | null = null;
  private connectorsSnapshot: ReadonlyMap<string, ConnectorStatus> = new Map();
  private connectorsSetter: ((connectors: ReadonlyMap<string, ConnectorStatus>) => void) | null =
    null;
  private approvalRequestSnapshot: PendingApproval | null = null;
  private approvalRequestSetter: ((request: PendingApproval | null) => void) | null = null;

  registerPrintOutput(handler: PrintOutputHandler | null): void {
    this.printOutputHandler = handler;
  }

  registerUpdateOutput(handler: UpdateOutputHandler | null): void {
    this.updateOutputHandler = handler;
  }

  registerStreamingHandler(handler: StreamingHandler | null): void {
    this.streamingHandler = handler;
  }

  registerClearOutputs(handler: (() => void) | null): void {
    this.clearOutputsHandler = handler;
  }

  registerActivitySetter(setter: ((activity: ActivityState) => void) | null): void {
    this.activitySetter = setter;
  }

  registerPromptSetter(setter: ((prompt: PromptState | null) => void) | null): void {
    this.promptSetter = setter;
    if (setter) {
      setter(this.promptSnapshot);
    }
  }

  registerWorkingDirectorySetter(setter: ((wd: string | null) => void) | null): void {
    this.workingDirectorySetter = setter;
    if (setter) {
      setter(this.workingDirectorySnapshot);
    }
  }

  registerRunStatsSetter(setter: ((stats: RunStats) => void) | null): void {
    this.runStatsSetter = setter;
    if (setter) {
      setter(this.runStatsSnapshot);
    }
  }

  registerCustomView(setter: (view: React.ReactNode | null) => void): () => void {
    this.customViewSetter = setter;
    setter(this.customViewSnapshot);
    return () => {
      if (this.customViewSetter === setter) {
        this.customViewSetter = null;
      }
    };
  }

  registerMessageQueueSetter(setter: ((queue: readonly string[]) => void) | null): void {
    this.messageQueueSetter = setter;
    if (setter) {
      setter(this.messageQueueSnapshot);
    }
  }

  registerChatBusySetter(setter: ((busy: boolean) => void) | null): void {
    this.chatBusySetter = setter;
    if (setter) {
      setter(this.chatBusySnapshot);
    }
  }

  registerInterruptHandler(setter: ((handler: (() => void) | null) => void) | null): void {
    this.interruptHandlerSetter = setter;
    if (setter) {
      const top = this.interruptHandlerStack[this.interruptHandlerStack.length - 1] ?? null;
      setter(top);
    }
  }

  requestRendererFallback = (): void => {
    this.rendererFallbackHandler?.();
  };

  registerRendererFallbackHandler = (handler: () => void): (() => void) => {
    this.rendererFallbackHandler = handler;
    return () => {
      if (this.rendererFallbackHandler === handler) {
        this.rendererFallbackHandler = null;
      }
    };
  };

  /** The menu currently awaiting a choice, or null. */
  setActiveMenu = (menu: ActiveMenu | null): void => {
    this.activeMenuSnapshot = menu;
    if (this.activeMenuSetter) this.activeMenuSetter(menu);
  };

  registerActiveMenuSetter(setter: ((menu: ActiveMenu | null) => void) | null): void {
    this.activeMenuSetter = setter;
    if (setter) {
      setter(this.activeMenuSnapshot);
    }
  }

  getActiveMenuSnapshot(): ActiveMenu | null {
    return this.activeMenuSnapshot;
  }

  /** Reachability of the named connectors, newest state wins per name. */
  setConnector = (name: string, status: ConnectorStatus): void => {
    const next = new Map(this.connectorsSnapshot);
    next.set(name, status);
    this.connectorsSnapshot = next;
    if (this.connectorsSetter) this.connectorsSetter(next);
  };

  registerConnectorsSetter(
    setter: ((connectors: ReadonlyMap<string, ConnectorStatus>) => void) | null,
  ): void {
    this.connectorsSetter = setter;
    if (setter) {
      setter(this.connectorsSnapshot);
    }
  }

  getConnectorsSnapshot(): ReadonlyMap<string, ConnectorStatus> {
    return this.connectorsSnapshot;
  }

  /**
   * The approval currently awaiting a decision, as structured data.
   *
   * The fullscreen approval card needs details that do not survive flattening
   * the request into a select prompt, so the request travels alongside it.
   */
  setApprovalRequest = (request: PendingApproval | null): void => {
    this.approvalRequestSnapshot = request;
    if (this.approvalRequestSetter) this.approvalRequestSetter(request);
  };

  registerApprovalRequestSetter(setter: ((request: PendingApproval | null) => void) | null): void {
    this.approvalRequestSetter = setter;
    if (setter) {
      setter(this.approvalRequestSnapshot);
    }
  }

  getApprovalRequestSnapshot(): PendingApproval | null {
    return this.approvalRequestSnapshot;
  }

  registerEphemeralRegionsSetter(
    setter: ((regions: readonly EphemeralRegion[]) => void) | null,
  ): void {
    this.ephemeralRegionsSetter = setter;
    if (setter) {
      setter(this.ephemeralRegionsSnapshot);
    }
  }

  registerExpandableReasoningSetter(
    setter: ((value: ExpandableReasoning | null) => void) | null,
  ): void {
    this.expandableReasoningSetter = setter;
    if (setter) {
      setter(this.expandableReasoningSnapshot);
    }
  }

  // ── Snapshot accessors (for hydrating late-registering components) ─

  getActivitySnapshot(): ActivityState {
    return this.activitySnapshot;
  }

  getPromptSnapshot(): PromptState | null {
    return this.promptSnapshot;
  }

  getWorkingDirectorySnapshot(): string | null {
    return this.workingDirectorySnapshot;
  }

  getRunStatsSnapshot(): RunStats {
    return this.runStatsSnapshot;
  }

  getEphemeralRegionsSnapshot(): readonly EphemeralRegion[] {
    return this.ephemeralRegionsSnapshot;
  }

  getExpandableReasoningSnapshot(): ExpandableReasoning | null {
    return this.expandableReasoningSnapshot;
  }

  getMessageQueueSnapshot(): readonly string[] {
    return this.messageQueueSnapshot;
  }

  getChatBusySnapshot(): boolean {
    return this.chatBusySnapshot;
  }

  // ── Pending queue management ──────────────────────────────────────

  hasPendingClear(): boolean {
    return this._pendingClear;
  }

  consumePendingClear(): void {
    this._pendingClear = false;
  }

  drainPendingOutputQueue(): OutputEntry[] {
    return this.pendingOutputQueue.splice(0, this.pendingOutputQueue.length);
  }
}

export const store = new UIStore();

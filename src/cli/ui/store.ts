import type React from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import type { StreamKind } from "./adapters/terminal-output-adapter";
import type { OutputEntry, PromptState } from "./types";

/** Accepts single entry or batch; returns first id when available. */
type PrintOutputHandler = (entry: OutputEntry | readonly OutputEntry[]) => string;

type StreamingHandler = {
  appendStream: (kind: StreamKind, delta: string) => void;
  finalizeStream: () => void;
};

const MAX_PENDING_OUTPUT_QUEUE = 2000;

/** Set when we've logged the queue-full warning once to avoid spam */
let _hasWarnedQueueFull = false;

interface ExpandableDiffPayload {
  readonly fullDiff: string;
  readonly timestamp: number;
}

/**
 * Persistent run-level stats surfaced in the status footer.
 *
 * All fields are optional so partial information renders gracefully —
 * the footer simply omits any field that hasn't been populated yet.
 * Most fields are session-totals, updated after each LLM round-trip.
 */
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
  private clearOutputsHandler: (() => void) | null = null;
  private streamingHandler: StreamingHandler | null = null;
  private pendingOutputQueue: OutputEntry[] = [];
  private _pendingClear = false;
  private pendingOutputIdCounter = 0;

  /** Coalesce rapid printOutput calls; flush on next microtask */
  private outputBatch: OutputEntry[] = [];
  private batchFlushScheduled = false;

  // Expandable diff for Ctrl+O expansion
  private expandableDiff: ExpandableDiffPayload | null = null;

  // Snapshots (kept in sync so late-registering components can hydrate)
  private promptSnapshot: PromptState | null = null;
  private activitySnapshot: ActivityState = { phase: "idle" };
  private workingDirectorySnapshot: string | null = null;
  private runStatsSnapshot: RunStats = {};
  private messageQueueSnapshot: string = "";
  private chatBusySnapshot: boolean = false;

  // React state setters (registered by island components)
  private promptSetter: ((prompt: PromptState | null) => void) | null = null;
  private activitySetter: ((activity: ActivityState) => void) | null = null;
  private workingDirectorySetter: ((wd: string | null) => void) | null = null;
  private runStatsSetter: ((stats: RunStats) => void) | null = null;
  private messageQueueSetter: ((queue: string) => void) | null = null;
  private chatBusySetter: ((busy: boolean) => void) | null = null;

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
  updateRunStats = (patch: Partial<RunStats>): void => {
    const next: RunStats = { ...this.runStatsSnapshot, ...patch };
    // Bail out if nothing changed (cheap by-key check).
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

  setCustomView = (_view: React.ReactNode | null): void => {};

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
   * Append text to the chat message queue. If the queue is non-empty, the new
   * text is joined to the existing content with a single newline.
   */
  appendToQueue = (text: string): void => {
    if (text.length === 0) return;
    const next =
      this.messageQueueSnapshot.length === 0 ? text : `${this.messageQueueSnapshot}\n${text}`;
    this.messageQueueSnapshot = next;
    this.messageQueueSetter?.(next);
  };

  /** Read the queue contents without clearing. */
  peekQueue = (): string => this.messageQueueSnapshot;

  /** Read the queue and clear it. */
  takeQueue = (): string => {
    const value = this.messageQueueSnapshot;
    if (value.length === 0) return "";
    this.messageQueueSnapshot = "";
    this.messageQueueSetter?.("");
    return value;
  };

  clearQueue = (): void => {
    if (this.messageQueueSnapshot.length === 0) return;
    this.messageQueueSnapshot = "";
    this.messageQueueSetter?.("");
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

    if (!this.clearOutputsHandler) {
      this._pendingClear = true;
      this.pendingOutputQueue.length = 0;
      return;
    }
    this.clearOutputsHandler();
  };

  // ── Registration methods (called by island components) ────────────

  registerPrintOutput(handler: PrintOutputHandler): void {
    this.printOutputHandler = handler;
  }

  registerStreamingHandler(handler: StreamingHandler | null): void {
    this.streamingHandler = handler;
  }

  registerClearOutputs(handler: () => void): void {
    this.clearOutputsHandler = handler;
  }

  registerActivitySetter(setter: (activity: ActivityState) => void): void {
    this.activitySetter = setter;
  }

  registerPromptSetter(setter: (prompt: PromptState | null) => void): void {
    this.promptSetter = setter;
  }

  registerWorkingDirectorySetter(setter: (wd: string | null) => void): void {
    this.workingDirectorySetter = setter;
  }

  registerRunStatsSetter(setter: (stats: RunStats) => void): void {
    this.runStatsSetter = setter;
  }

  registerCustomView(setter: (view: React.ReactNode | null) => void): void {
    this.setCustomView = setter;
  }

  registerMessageQueueSetter(setter: (queue: string) => void): void {
    this.messageQueueSetter = setter;
    setter(this.messageQueueSnapshot);
  }

  registerChatBusySetter(setter: (busy: boolean) => void): void {
    this.chatBusySetter = setter;
    setter(this.chatBusySnapshot);
  }

  registerInterruptHandler(setter: ((handler: (() => void) | null) => void) | null): void {
    this.interruptHandlerSetter = setter;
    if (setter) {
      const top = this.interruptHandlerStack[this.interruptHandlerStack.length - 1] ?? null;
      setter(top);
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

  getMessageQueueSnapshot(): string {
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

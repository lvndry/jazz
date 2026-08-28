/**
 * Global UI state store (`UIStore`) that every "island" component reads via
 * `useSyncExternalStore`, sliced by concern (output, session, prompt,
 * ephemeral) so a change in one slice doesn't re-render unrelated islands.
 */

import { useSyncExternalStore } from "react";
import { isActivityEqual, type ActivityState } from "./activity-state";
import {
  initialScrollbackState,
  reduceScrollback,
  type PendingStream,
  type ScrollbackState,
  type StreamKind,
} from "./adapters/terminal-output-adapter";
import type { OutputEntry, OutputEntryWithId, PromptState } from "./types";

type ModeSwitchHandler = (mode: "safe" | "yolo") => void;

const EMPTY_STREAM = "";
const EMPTY_OUTPUT_ENTRIES: readonly OutputEntryWithId[] = [];
const EMPTY_QUEUE: readonly string[] = [];
const EMPTY_REGIONS: readonly EphemeralRegion[] = [];
const EMPTY_CONNECTORS: ReadonlyMap<string, ConnectorStatus> = new Map();
const EMPTY_RUN_STATS: RunStats = {};

interface ExpandableDiffPayload {
  readonly fullDiff: string;
  readonly timestamp: number;
}

export type EphemeralKind = "reasoning" | "subagent";

export type EphemeralRegionId = string;

export interface EphemeralRegion {
  readonly id: EphemeralRegionId;
  readonly kind: EphemeralKind;
  readonly label: string;
  readonly startedAt: number;
  readonly tail: readonly string[];
  readonly maxLines: number;
}

export interface ExpandableReasoning {
  readonly fullText: string;
  readonly label: string;
  readonly durationMs: number;
  readonly tokens?: number;
  readonly entryId?: string;
}

const MAX_EXPANDABLE_REASONING = 20;

const MAX_INPUT_HISTORY = 100;

export interface CollapseEphemeralSummary {
  readonly line?: string;
  readonly fullText?: string;
  readonly durationMs: number;
  readonly tokens?: number;
}

export type ConnectorStatus = "live" | "renew" | "offline";

/**
 * A menu the app is waiting on, published as data rather than as a rendered tree.
 *
 * Continuations stay on the write side (`completePrompt`). Putting `onSelect` /
 * `onExit` on the snapshot would smuggle closures through a contract two
 * renderers share, and the second renderer would still have nothing it can
 * serialize or replay.
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

export interface ActiveMenuFact {
  readonly label: string;
  readonly detail: string;
}

export interface ActiveAgentChoice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly persona: string;
  readonly description?: string;
  readonly lastUsed?: boolean;
}

export interface ActiveWizardMenu {
  readonly kind: "menu";
  readonly title?: string;
  readonly options: readonly ActiveMenuOption[];
  readonly requirements?: readonly ActiveMenuRequirement[];
  readonly environment?: readonly ActiveMenuFact[];
  readonly tip?: string;
}

export interface ActiveAgentMenu {
  readonly kind: "agents";
  readonly title: string;
  readonly action: string;
  readonly agents: readonly ActiveAgentChoice[];
  readonly browse?: boolean;
}

export type ActiveMenu = ActiveWizardMenu | ActiveAgentMenu;

/** Discriminated surface a renderer paints in place of the chat transcript. */
export type SurfaceIntent = ActiveMenu;

/** How a renderer answers the surface currently published on the store. */
export type PromptResult =
  { readonly kind: "select"; readonly value: string } | { readonly kind: "exit" };

export interface CurrentConversation {
  readonly agentId: string;
  readonly conversationId: string;
}

export interface PendingApproval {
  readonly toolName: string;
  readonly executeToolName: string;
  readonly message: string;
  readonly args: Record<string, unknown>;
  readonly previewDiff?: string;
}

export interface RunStats {
  readonly model?: string;
  readonly provider?: string;
  readonly tokensInContext?: number;
  readonly maxContextTokens?: number;
  /** Session-cumulative billed prompt tokens. Distinct from `tokensInContext`. */
  readonly promptTokens?: number;
  /** Session-cumulative billed completion tokens. */
  readonly completionTokens?: number;
  readonly costUSD?: number;
}

export interface OutputSnapshot {
  readonly entries: readonly OutputEntryWithId[];
  readonly pending: PendingStream | null;
  readonly streaming: string;
  readonly staticGeneration: number;
}

export interface SessionSnapshot {
  readonly activity: ActivityState;
  readonly runStats: RunStats;
  readonly workingDirectory: string | null;
  readonly currentConversation: CurrentConversation | null;
  readonly chatBusy: boolean;
  readonly isYolo: boolean;
  readonly connectors: ReadonlyMap<string, ConnectorStatus>;
  readonly interruptHandler: (() => void) | null;
  readonly approvalRequest: PendingApproval | null;
  readonly activeMenu: ActiveMenu | null;
  readonly modeToast: string | null;
}

export interface PromptSnapshot {
  readonly prompt: PromptState | null;
  readonly messageQueue: readonly string[];
}

export interface EphemeralSnapshot {
  readonly regions: readonly EphemeralRegion[];
  readonly expandableReasoning: ExpandableReasoning | null;
}

const INITIAL_OUTPUT: OutputSnapshot = {
  entries: EMPTY_OUTPUT_ENTRIES,
  pending: null,
  streaming: EMPTY_STREAM,
  staticGeneration: 0,
};

const INITIAL_SESSION: SessionSnapshot = {
  activity: { phase: "idle" },
  runStats: EMPTY_RUN_STATS,
  workingDirectory: null,
  currentConversation: null,
  chatBusy: false,
  isYolo: false,
  connectors: EMPTY_CONNECTORS,
  interruptHandler: null,
  approvalRequest: null,
  activeMenu: null,
  modeToast: null,
};

const INITIAL_PROMPT: PromptSnapshot = {
  prompt: null,
  messageQueue: EMPTY_QUEUE,
};

const INITIAL_EPHEMERAL: EphemeralSnapshot = {
  regions: EMPTY_REGIONS,
  expandableReasoning: null,
};

class StoreSlice<T> {
  private snapshot: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.snapshot = initial;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): T => this.snapshot;

  set(next: T): void {
    if (Object.is(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function patchSlice<T extends object>(slice: StoreSlice<T>, patch: Partial<T>): void {
  const previous = slice.getSnapshot();
  let changed = false;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (!Object.is(previous[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  slice.set({ ...previous, ...patch });
}

function outputFromScrollback(state: ScrollbackState): OutputSnapshot {
  return {
    entries: state.staticEntries,
    pending: state.pending,
    streaming: state.pending === null ? EMPTY_STREAM : state.pending.rawTail,
    staticGeneration: state.staticGeneration,
  };
}

export class UIStore {
  private readonly output = new StoreSlice<OutputSnapshot>(INITIAL_OUTPUT);
  private readonly session = new StoreSlice<SessionSnapshot>(INITIAL_SESSION);
  private readonly prompt = new StoreSlice<PromptSnapshot>(INITIAL_PROMPT);
  private readonly ephemeral = new StoreSlice<EphemeralSnapshot>(INITIAL_EPHEMERAL);

  private scrollback: ScrollbackState = initialScrollbackState();
  private pinnedReasoningIds = new Set<EphemeralRegionId>();
  private collapseReasoning = true;
  private pendingOutputIdCounter = 0;
  private outputBatch: OutputEntryWithId[] = [];
  private batchFlushScheduled = false;
  private expandableDiff: ExpandableDiffPayload | null = null;
  private modeSwitchHandler: ModeSwitchHandler | null = null;
  private sessionCostUSD = 0;
  private sessionPromptTokens = 0;
  private sessionCompletionTokens = 0;
  private expandableReasoningStack: ExpandableReasoning[] = [];
  private inputHistory: string[] = [];
  private ephemeralRegions: Map<EphemeralRegionId, EphemeralRegion> = new Map();
  private ephemeralIdCounter = 0;
  private interruptHandlerStack: Array<() => void> = [];
  private promptContinuation: ((result: PromptResult) => void) | null = null;
  private rendererFallbackHandler: (() => void) | null = null;

  subscribeOutput = (listener: () => void): (() => void) => this.output.subscribe(listener);
  getOutputSnapshot = (): OutputSnapshot => this.output.getSnapshot();

  subscribeSession = (listener: () => void): (() => void) => this.session.subscribe(listener);
  getSessionSnapshot = (): SessionSnapshot => this.session.getSnapshot();

  subscribePrompt = (listener: () => void): (() => void) => this.prompt.subscribe(listener);
  getPromptSlice = (): PromptSnapshot => this.prompt.getSnapshot();

  subscribeEphemeral = (listener: () => void): (() => void) => this.ephemeral.subscribe(listener);
  getEphemeralSnapshot = (): EphemeralSnapshot => this.ephemeral.getSnapshot();

  private publishScrollback(next: ScrollbackState): void {
    if (Object.is(next, this.scrollback)) return;
    this.scrollback = next;
    this.output.set(outputFromScrollback(next));
  }

  private flushOutputBatch = (): void => {
    this.batchFlushScheduled = false;
    this.doFlushBatch();
  };

  private doFlushBatch(): void {
    if (this.outputBatch.length === 0) return;
    const batch = this.outputBatch;
    this.outputBatch = [];
    this.publishScrollback(
      reduceScrollback(this.scrollback, { type: "appendStatic", entries: batch }),
    );
  }

  flushOutputBatchNow(): void {
    if (this.batchFlushScheduled) {
      this.batchFlushScheduled = false;
    }
    this.doFlushBatch();
  }

  printOutput = (entry: OutputEntry): string => {
    const id = entry.id ?? `queued-output-${++this.pendingOutputIdCounter}`;
    const entryWithId: OutputEntryWithId = entry.id
      ? (entry as OutputEntryWithId)
      : { ...entry, id };
    this.outputBatch.push(entryWithId);
    if (!this.batchFlushScheduled) {
      this.batchFlushScheduled = true;
      queueMicrotask(this.flushOutputBatch);
    }
    return id;
  };

  private updateOutputEntry(id: string, patch: OutputEntry): void {
    const previous = this.output.getSnapshot();
    let found = false;
    const entries = previous.entries.map((entry) => {
      if (entry.id !== id) return entry;
      found = true;
      return {
        ...entry,
        ...patch,
        id,
        meta: { ...entry.meta, ...patch.meta },
      };
    });
    if (!found) return;
    this.scrollback = { ...this.scrollback, staticEntries: entries };
    this.output.set({ ...previous, entries });
  }

  setPrompt = (nextPrompt: PromptState | null): void => {
    patchSlice(this.prompt, { prompt: nextPrompt });
  };

  setActivity = (activity: ActivityState): void => {
    if (isActivityEqual(this.session.getSnapshot().activity, activity)) {
      return;
    }
    patchSlice(this.session, { activity });
  };

  setCurrentConversation = (conversation: CurrentConversation | null): void => {
    patchSlice(this.session, { currentConversation: conversation });
  };

  setWorkingDirectory = (workingDirectory: string | null): void => {
    patchSlice(this.session, { workingDirectory });
  };

  resetRunStats = (initial: RunStats = EMPTY_RUN_STATS): void => {
    this.sessionCostUSD = 0;
    this.sessionPromptTokens = initial.promptTokens ?? 0;
    this.sessionCompletionTokens = initial.completionTokens ?? 0;
    patchSlice(this.session, { runStats: initial });
  };

  addSessionCostUSD = (deltaUSD: number): void => {
    if (!deltaUSD) return;
    this.sessionCostUSD += deltaUSD;
    this.updateRunStats({ costUSD: this.sessionCostUSD });
  };

  addSessionUsage = (usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  }): void => {
    if (!usage.promptTokens && !usage.completionTokens) return;
    this.sessionPromptTokens += usage.promptTokens;
    this.sessionCompletionTokens += usage.completionTokens;
    this.updateRunStats({
      promptTokens: this.sessionPromptTokens,
      completionTokens: this.sessionCompletionTokens,
    });
  };

  updateRunStats = (patch: Partial<RunStats>): void => {
    const previous = this.session.getSnapshot().runStats;
    const next: RunStats = { ...previous, ...patch };
    let changed = false;
    for (const key of Object.keys(patch) as (keyof RunStats)[]) {
      if (previous[key] !== next[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    patchSlice(this.session, { runStats: next });
  };

  setInterruptHandler = (handler: (() => void) | null): void => {
    if (handler === null) {
      this.interruptHandlerStack.pop();
    } else {
      this.interruptHandlerStack.push(handler);
    }
    const top = this.interruptHandlerStack[this.interruptHandlerStack.length - 1] ?? null;
    patchSlice(this.session, { interruptHandler: top });
  };

  appendToQueue = (text: string): void => {
    if (text.length === 0) return;
    const next = [...this.prompt.getSnapshot().messageQueue, text];
    patchSlice(this.prompt, { messageQueue: next });
  };

  peekQueue = (): string => this.prompt.getSnapshot().messageQueue.join("\n");

  takeQueue = (): string => {
    const queue = this.prompt.getSnapshot().messageQueue;
    if (queue.length === 0) return "";
    const value = queue.join("\n");
    patchSlice(this.prompt, { messageQueue: EMPTY_QUEUE });
    return value;
  };

  clearQueue = (): void => {
    if (this.prompt.getSnapshot().messageQueue.length === 0) return;
    patchSlice(this.prompt, { messageQueue: EMPTY_QUEUE });
  };

  /**
   * Set when the user asks to flush the queue into the running chat immediately
   * (Esc with queued messages during a run). The chat loop reads and clears this
   * on its next turn so the queued entries are drained even though the prior turn
   * ended in an interrupt, which would otherwise seed them for re-editing.
   */
  private flushQueueRequested = false;

  requestFlushQueue = (): void => {
    this.flushQueueRequested = true;
  };

  consumeFlushQueue = (): boolean => {
    const requested = this.flushQueueRequested;
    this.flushQueueRequested = false;
    return requested;
  };

  setChatBusy = (busy: boolean): void => {
    patchSlice(this.session, { chatBusy: busy });
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

  registerModeSwitchHandler = (handler: ModeSwitchHandler | null): void => {
    this.modeSwitchHandler = handler;
  };

  requestModeSwitch = (mode: "safe" | "yolo"): void => {
    if (this.modeSwitchHandler) {
      this.modeSwitchHandler(mode);
    }
  };

  toggleMode = (): void => {
    const nextMode = this.session.getSnapshot().isYolo ? "safe" : "yolo";
    patchSlice(this.session, { isYolo: !this.session.getSnapshot().isYolo });
    this.requestModeSwitch(nextMode);
  };

  setModeIsYolo = (isYolo: boolean): void => {
    patchSlice(this.session, { isYolo });
  };

  getModeIsYolo = (): boolean => this.session.getSnapshot().isYolo;

  showModeToast = (message: string): void => {
    patchSlice(this.session, { modeToast: message });
  };

  clearModeToast = (): void => {
    patchSlice(this.session, { modeToast: null });
  };

  private publishEphemeralRegions(): void {
    const regions =
      this.ephemeralRegions.size === 0 ? EMPTY_REGIONS : Array.from(this.ephemeralRegions.values());
    patchSlice(this.ephemeral, { regions });
  }

  private setExpandableReasoning(value: ExpandableReasoning | null): void {
    patchSlice(this.ephemeral, { expandableReasoning: value });
  }

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

  setCollapseReasoning = (enabled: boolean): void => {
    this.collapseReasoning = enabled;
  };

  collapseEphemeral = (id: EphemeralRegionId, summary: CollapseEphemeralSummary): void => {
    const region = this.ephemeralRegions.get(id);
    if (!region) return;

    this.ephemeralRegions.delete(id);
    this.publishEphemeralRegions();

    const capturedText = summary.fullText?.trim() || region.tail.join("\n").trim();
    const pinned = this.pinnedReasoningIds.delete(id);
    const keepExpanded = pinned || !this.collapseReasoning;

    if (region.kind === "reasoning" && capturedText.length > 0) {
      const entryId = `reasoning-${id}`;
      const seconds = (summary.durationMs / 1000).toFixed(1);
      this.printOutput({
        id: entryId,
        type: "streamContent",
        message: keepExpanded
          ? `*${region.label} · ${seconds}s*\n\n${capturedText}`
          : (summary.line ?? `${region.label} · ${seconds}s · ctrl+r to expand`),
        meta: {
          kind: "reasoning",
          collapsed: !keepExpanded,
          fullText: capturedText,
          durationMs: summary.durationMs,
          label: region.label,
        },
        timestamp: new Date(),
      });
      this.flushOutputBatchNow();
      if (this.collapseReasoning) {
        this.pushExpandableReasoning({
          fullText: capturedText,
          label: region.label,
          durationMs: summary.durationMs,
          entryId,
          ...(summary.tokens !== undefined && { tokens: summary.tokens }),
        });
      }
      return;
    }

    if (summary.line) {
      this.printOutput({
        type: "log",
        message: summary.line,
        timestamp: new Date(),
      });
      this.flushOutputBatchNow();
    }
  };

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

  collapseAllEphemeral = (): void => {
    if (this.ephemeralRegions.size === 0) return;
    for (const region of this.ephemeralRegions.values()) {
      if (region.kind !== "reasoning") continue;
      const fullText = region.tail.join("\n").trim();
      if (fullText.length === 0) continue;
      const durationMs = Date.now() - region.startedAt;
      if (!this.collapseReasoning) {
        const seconds = (durationMs / 1000).toFixed(1);
        this.printOutput({
          id: `reasoning-${region.id}`,
          type: "streamContent",
          message: `*${region.label} · ${seconds}s*\n\n${fullText}`,
          meta: {
            kind: "reasoning",
            collapsed: false,
            fullText,
            durationMs,
            label: region.label,
          },
          timestamp: new Date(),
        });
        this.flushOutputBatchNow();
        continue;
      }
      this.pushExpandableReasoning({
        fullText,
        label: region.label,
        durationMs,
      });
    }
    this.ephemeralRegions.clear();
    this.publishEphemeralRegions();
  };

  pinOpenReasoning = (): boolean => {
    let pinned = false;
    for (const region of this.ephemeralRegions.values()) {
      if (region.kind !== "reasoning") continue;
      this.pinnedReasoningIds.add(region.id);
      pinned = true;
    }
    return pinned;
  };

  // Ink's <Static> never repaints entries it has already emitted, so the
  // islands renderer must ask for "append": patching the collapsed stub
  // in place would change the store without changing the screen.
  expandLastReasoning = (target: "in-place" | "append" = "in-place"): boolean => {
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
      ...(target === "in-place" && value.entryId !== undefined ? { id: value.entryId } : {}),
    };
    if (target === "in-place" && value.entryId !== undefined) {
      this.flushOutputBatchNow();
      this.updateOutputEntry(value.entryId, entry);
    } else {
      this.printOutput(entry);
      this.flushOutputBatchNow();
    }
    this.setExpandableReasoning(this.expandableReasoningStack.at(-1) ?? null);
    return true;
  };

  appendStream = (kind: StreamKind, delta: string): void => {
    if (delta.length === 0) return;
    this.flushOutputBatchNow();
    this.publishScrollback(
      reduceScrollback(this.scrollback, {
        type: "appendStream",
        kind,
        delta,
        nextId: `queued-output-${++this.pendingOutputIdCounter}`,
        finalizeId: `queued-output-${++this.pendingOutputIdCounter}`,
      }),
    );
  };

  finalizeStream = (): void => {
    this.flushOutputBatchNow();
    this.publishScrollback(
      reduceScrollback(this.scrollback, {
        type: "finalizeStream",
        finalizeId: `queued-output-${++this.pendingOutputIdCounter}`,
      }),
    );
  };

  clearOutputs = (): void => {
    this.outputBatch = [];
    this.batchFlushScheduled = false;
    this.expandableReasoningStack = [];
    this.pinnedReasoningIds.clear();
    this.setExpandableReasoning(null);
    this.publishScrollback(reduceScrollback(this.scrollback, { type: "clear" }));
  };

  /** Publish a data-only menu. Pass the continuation here, not on the snapshot. */
  setActiveMenu = (menu: ActiveMenu | null, onComplete?: (result: PromptResult) => void): void => {
    this.promptContinuation = menu === null ? null : (onComplete ?? null);
    patchSlice(this.session, { activeMenu: menu });
  };

  /**
   * Answer the published surface. Clears the snapshot, then invokes the
   * write-side continuation once. A second call is a no-op.
   */
  completePrompt = (result: PromptResult): void => {
    if (this.session.getSnapshot().activeMenu === null && this.promptContinuation === null) {
      return;
    }
    const continuation = this.promptContinuation;
    this.promptContinuation = null;
    patchSlice(this.session, { activeMenu: null });
    continuation?.(result);
  };

  getActiveMenuSnapshot(): ActiveMenu | null {
    return this.session.getSnapshot().activeMenu;
  }

  setConnector = (name: string, status: ConnectorStatus): void => {
    const next = new Map(this.session.getSnapshot().connectors);
    next.set(name, status);
    patchSlice(this.session, { connectors: next });
  };

  getConnectorsSnapshot(): ReadonlyMap<string, ConnectorStatus> {
    return this.session.getSnapshot().connectors;
  }

  setApprovalRequest = (request: PendingApproval | null): void => {
    patchSlice(this.session, { approvalRequest: request });
  };

  getApprovalRequestSnapshot(): PendingApproval | null {
    return this.session.getSnapshot().approvalRequest;
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

  getActivitySnapshot(): ActivityState {
    return this.session.getSnapshot().activity;
  }

  getPromptSnapshot(): PromptState | null {
    return this.prompt.getSnapshot().prompt;
  }

  getCurrentConversationSnapshot(): CurrentConversation | null {
    return this.session.getSnapshot().currentConversation;
  }

  getWorkingDirectorySnapshot(): string | null {
    return this.session.getSnapshot().workingDirectory;
  }

  getRunStatsSnapshot(): RunStats {
    return this.session.getSnapshot().runStats;
  }

  getEphemeralRegionsSnapshot(): readonly EphemeralRegion[] {
    return this.ephemeral.getSnapshot().regions;
  }

  getExpandableReasoningSnapshot(): ExpandableReasoning | null {
    return this.ephemeral.getSnapshot().expandableReasoning;
  }

  getMessageQueueSnapshot(): readonly string[] {
    return this.prompt.getSnapshot().messageQueue;
  }

  getChatBusySnapshot(): boolean {
    return this.session.getSnapshot().chatBusy;
  }
}

export const store = new UIStore();

export function useOutputSlice(): OutputSnapshot {
  return useSyncExternalStore(
    store.subscribeOutput,
    store.getOutputSnapshot,
    store.getOutputSnapshot,
  );
}

export function useSessionSlice(): SessionSnapshot {
  return useSyncExternalStore(
    store.subscribeSession,
    store.getSessionSnapshot,
    store.getSessionSnapshot,
  );
}

export function usePromptSlice(): PromptSnapshot {
  return useSyncExternalStore(store.subscribePrompt, store.getPromptSlice, store.getPromptSlice);
}

export function useEphemeralSlice(): EphemeralSnapshot {
  return useSyncExternalStore(
    store.subscribeEphemeral,
    store.getEphemeralSnapshot,
    store.getEphemeralSnapshot,
  );
}

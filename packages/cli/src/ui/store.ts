/**
 * Owns the canonical semantic presentation document and interactive state.
 * Producers commit facts before layout; durable readers use getDocumentSnapshot.
 * The fullscreen adapter observes coherent getPresentationSnapshot revisions,
 * while classic Ink consumes disposable append-only projections. Prompt and
 * approval continuations stay on the write side and never enter source content.
 */

import type { LlmRetryNotice } from "@jazz/core/interfaces/presentation";
import type { SkillMetadata } from "@jazz/core/skills/skill-service";
import type {
  PresentationContent,
  PresentationDocument,
  PresentationEntry,
} from "@jazz/core/types/presentation-content";
import type { ToolRiskLevel } from "@jazz/core/types/tools";
import { useSyncExternalStore } from "react";
import { isCommandInput } from "@/cli/chat/commands/parser";
import { isActivityEqual, type ActivityState } from "./activity-state";
import {
  createClassicProjection,
  type PendingStream,
  type StreamKind,
} from "./adapters/terminal-output-adapter";
import {
  appendDocumentEntries,
  appendDocumentStream,
  settleDocumentStream,
  contentFromOutput,
} from "./document";
import type { LocalModelHosts } from "./local-model-hosts";
import {
  appendToSubagentRun,
  finishSubagentRun,
  finishSubagentTool,
  openSubagentRun,
  startSubagentTool,
  steerSubagentRun,
  takeSubagentMessages,
  type SubagentChannel,
  type SubagentRun,
  type SubagentStatus,
} from "./subagent-runs";
import { createStreamPacer, type StreamPacer } from "./text/stream-pacer";
import { addThoughtStep, NO_THOUGHT, thoughtText, type TurnThought } from "./turn-thought";
import type { OutputEntry, OutputEntryWithId, PromptState } from "./types";

type ModeSwitchHandler = (mode: "safe" | "yolo") => void;

const EMPTY_STREAM = "";
const EMPTY_OUTPUT_ENTRIES: readonly OutputEntryWithId[] = [];
const EMPTY_QUEUE: readonly string[] = [];

function isQueuedCommand(entry: string): boolean {
  const trimmed = entry.trim();
  return isCommandInput(trimmed) && !trimmed.includes("\n");
}
const EMPTY_REGIONS: readonly EphemeralRegion[] = [];
const EMPTY_SUBAGENT_RUNS: readonly SubagentRun[] = [];
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
  /** How many reasoning steps of a turn this stands for. */
  readonly steps?: number;
  readonly tokens?: number;
  readonly entryId?: string;
  readonly entryIds?: readonly string[];
}

const MAX_EXPANDABLE_REASONING = 20;

const MAX_INPUT_HISTORY = 100;

export interface CollapseEphemeralSummary {
  readonly line?: string;
  readonly fullText?: string;
  readonly durationMs: number;
  readonly tokens?: number;
  /** How a sub-agent region ended. Absent means it completed. */
  readonly status?: Exclude<SubagentStatus, "running">;
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
  /** A few words shown beside the label, such as a setting's current value. */
  readonly hint?: string;
}

/** A slash command home's composer runs, such as `/resume`. */
export interface ActiveHomeCommand {
  /** Without the slash. */
  readonly name: string;
  readonly description: string;
  readonly value: string;
}

/** One row of the first-run list: an action and the value home answers with. */
export interface ActiveHomeAction {
  readonly label: string;
  readonly value: string;
}

/** An agent home offers to start a conversation with. */
export interface ActiveHomeAgent {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly persona: string;
  /** When it was last in a conversation, already worded: "2h ago". Absent when never. */
  readonly lastUsed?: string;
}

/** A conversation whose goal or loop is blocked on you. */
export interface ActiveHomeWaiting {
  readonly key: string;
  readonly value: string;
  /** What it is about, in words. */
  readonly title: string;
  readonly agent: string;
  readonly reason: "question" | "approval" | "review" | "stopped";
  /** Relative age, already worded: "1d ago". */
  readonly age: string;
  /** The question, or the decision it needs. */
  readonly detail?: string;
}

/** Something the first-run screen found already set up on this machine. */
export interface ActiveHomeDetection {
  readonly label: string;
  readonly detail: string;
}

/**
 * The home screen as data. The renderer owns which agent is chosen and what is typed, and
 * answers with the chosen agent and the text; the actions are addressed by key.
 */
export interface ActiveHome {
  readonly kind: "home";
  /** Identifies one showing of home. A refresh keeps it, so the choice and the typing survive. */
  readonly shownAt: number;
  /** The recent agents, most recent first. */
  readonly agents: readonly ActiveHomeAgent[];
  /** Every agent, for the "all N" hint. */
  readonly agentCount: number;
  /** The agent chosen when home opens; the first offered when absent. */
  readonly targetAgentId?: string;
  /** Text to put back in the composer, after the agent picker. */
  readonly draft?: string;
  readonly waiting: readonly ActiveHomeWaiting[];
  /** What `/` offers in the composer. */
  readonly commands: readonly ActiveHomeCommand[];
  /** A readiness problem, shown on the right of the footer with the command that fixes it. */
  readonly warning?: { readonly text: string; readonly fix: string };
  /** Present when there is no agent yet: what setup found, and what to do about it. */
  readonly firstRun?: {
    readonly detected: readonly ActiveHomeDetection[];
    readonly actions: readonly ActiveHomeAction[];
  };
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
}

export interface ActiveAgentMenu {
  readonly kind: "agents";
  readonly title: string;
  readonly action: string;
  readonly agents: readonly ActiveAgentChoice[];
  readonly initialIndex?: number;
}

/** Read-only agent configuration, projected to safe display rows by the wizard. */
export interface ActiveAgentDetails {
  readonly kind: "agent-details";
  readonly name: string;
  readonly fields: readonly {
    readonly section: string;
    readonly label: string;
    readonly value: string;
  }[];
}

/** Skill catalog presented as a searchable, read-only terminal surface. */
export interface ActiveSkillMenu {
  readonly kind: "skills";
  readonly skills: readonly SkillMetadata[];
}

export type ActiveMenu =
  ActiveHome | ActiveWizardMenu | ActiveAgentMenu | ActiveAgentDetails | ActiveSkillMenu;

/** Discriminated surface a renderer paints in place of the chat transcript. */
export type SurfaceIntent = ActiveMenu;

/** How a renderer answers the surface currently published on the store. */
export type PromptResult =
  /** `text` carries what was typed with the choice, such as home's first message. */
  | { readonly kind: "select"; readonly value: string; readonly text?: string }
  | { readonly kind: "exit" };

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
  /** What approving concretely does, with real numbers (`214 files, 1.3 GB`). */
  readonly impact?: string;
  readonly riskLevel?: ToolRiskLevel;
  /** A caution the card shows even when it replaces the tool's prose (untrusted content read this run). */
  readonly warning?: string;
  /** The argument `e` lets a person rewrite before accepting. */
  readonly editableArg?: string;
}

export interface RunStats {
  readonly model?: string;
  readonly provider?: string;
  /** Reasoning effort the conversation runs at, e.g. `medium`; unset when reasoning is off. */
  readonly reasoning?: string | undefined;
  /** Resolved endpoint hosts for the conversation's local model providers. */
  readonly localModelHosts?: LocalModelHosts;
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
  /** Ctrl+B: detach the in-flight tool call into the background instead of killing it. */
  readonly backgroundHandler: (() => void) | null;
  readonly approvalRequest: PendingApproval | null;
  readonly activeMenu: ActiveMenu | null;
  readonly modeToast: string | null;
  /** A model call that failed and is scheduled to be tried again. Cleared once the model answers. */
  readonly retryNotice: RetryNotice | null;
  /** When the current turn started, for "stopped by you after 6.2s"; null between turns. */
  readonly busySince: number | null;
}

/** A scheduled retry, with the wall-clock time it will be sent so a countdown stays true. */
export interface RetryNotice extends LlmRetryNotice {
  readonly retryAt: number;
}

export interface PromptSnapshot {
  readonly prompt: PromptState | null;
  readonly messageQueue: readonly string[];
}

export interface EphemeralSnapshot {
  readonly regions: readonly EphemeralRegion[];
  readonly expandableReasoning: ExpandableReasoning | null;
}

export interface SubagentsSnapshot {
  /** This turn's sub-agents in spawn order, finished ones included. */
  readonly runs: readonly SubagentRun[];
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
  backgroundHandler: null,
  approvalRequest: null,
  activeMenu: null,
  modeToast: null,
  retryNotice: null,
  busySince: null,
};

const INITIAL_PROMPT: PromptSnapshot = {
  prompt: null,
  messageQueue: EMPTY_QUEUE,
};

const INITIAL_EPHEMERAL: EphemeralSnapshot = {
  regions: EMPTY_REGIONS,
  expandableReasoning: null,
};

const INITIAL_SUBAGENTS: SubagentsSnapshot = {
  runs: EMPTY_SUBAGENT_RUNS,
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

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  set(next: T, notify = true): void {
    if (Object.is(this.snapshot, next)) return;
    this.snapshot = next;
    if (notify) this.notify();
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

export interface PresentationSnapshot {
  readonly revision: number;
  /** Mounted-view lifetime; replacements retire it even when source IDs are reused. */
  readonly documentGeneration: number;
  readonly document: PresentationDocument;
  readonly session: SessionSnapshot;
  readonly ephemeral: EphemeralSnapshot;
  readonly subagents: SubagentsSnapshot;
  readonly expandedReasoningIds: ReadonlySet<string>;
  readonly liveReasoningIds: ReadonlySet<string>;
  readonly streamReveal: { readonly id: string; readonly length: number } | null;
}

export class UIStore {
  private readonly output = new StoreSlice<OutputSnapshot>(INITIAL_OUTPUT);
  private readonly session = new StoreSlice<SessionSnapshot>(INITIAL_SESSION);
  private readonly prompt = new StoreSlice<PromptSnapshot>(INITIAL_PROMPT);
  private readonly ephemeral = new StoreSlice<EphemeralSnapshot>(INITIAL_EPHEMERAL);
  private readonly subagents = new StoreSlice<SubagentsSnapshot>(INITIAL_SUBAGENTS);

  private readonly sourceNamespace = crypto.randomUUID();
  private document: PresentationDocument = { id: "session:0", revision: 0, entries: [] };
  private documentGeneration = 0;
  private classicProjection: ReturnType<typeof createClassicProjection> | undefined;
  private classicDirty = false;
  private classicSubscribers = 0;
  private classicNotificationPending = false;
  private readonly expandedReasoningIds = new Set<string>();
  private readonly liveReasoningIds = new Set<string>();
  private turnThoughtIds: string[] = [];
  private readonly reasoningReplays: Array<{
    readonly id: string;
    readonly sourceIds: readonly string[];
  }> = [];
  private readonly deferredReasoningIds = new Set<string>();
  private streamReveal: { readonly id: string; readonly length: number } | null = null;
  private presentationRevision = 0;
  private presentationCommitting = false;
  private presentationCommitScheduled = false;
  private presentationSnapshot!: PresentationSnapshot;
  private readonly presentationListeners = new Set<() => void>();

  constructor() {
    for (const slice of [this.session, this.ephemeral, this.subagents]) {
      slice.subscribe(this.schedulePresentationCommit);
    }
    this.commitPresentation();
  }

  private schedulePresentationCommit = (): void => {
    if (this.presentationCommitScheduled || this.presentationCommitting) return;
    this.presentationCommitScheduled = true;
    queueMicrotask(() => {
      if (this.presentationCommitScheduled) this.commitPresentation();
    });
  };

  private commitPresentation = (): void => {
    this.presentationCommitScheduled = false;
    this.presentationCommitting = true;
    this.doFlushBatch();
    this.presentationCommitting = false;
    this.presentationSnapshot = {
      revision: ++this.presentationRevision,
      documentGeneration: this.documentGeneration,
      document: this.document,
      session: this.session.getSnapshot(),
      ephemeral: this.ephemeral.getSnapshot(),
      subagents: this.subagents.getSnapshot(),
      expandedReasoningIds: new Set(this.expandedReasoningIds),
      liveReasoningIds: new Set(this.liveReasoningIds),
      streamReveal: this.streamReveal,
    };
    if (this.classicNotificationPending) {
      this.classicNotificationPending = false;
      if (this.classicSubscribers > 0) {
        if (this.classicDirty) this.computeClassicProjection(true);
        else this.output.notify();
      }
    }
    for (const listener of this.presentationListeners) listener();
  };

  subscribePresentation = (listener: () => void): (() => void) => {
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  };

  getPresentationSnapshot = (): PresentationSnapshot => this.presentationSnapshot;
  /** Capture on presenter creation; replacing or clearing the document retires it. */
  captureDocumentLease = (): (() => boolean) => {
    const generation = this.documentGeneration;
    return () => generation === this.documentGeneration;
  };
  getDocumentSnapshot = (): PresentationDocument => this.document;
  isReasoningExpanded = (id: string): boolean => this.expandedReasoningIds.has(id);

  /** Replace source entries as one transaction; history never reprints rendered rows. */
  replaceDocument = (id: string, entries: readonly PresentationEntry[]): void => {
    this.streamPacer.reset();
    this.outputBatch = [];
    this.resetDocumentControls();
    this.documentGeneration += 1;
    this.publishDocument({ id, revision: this.document.revision + 1, entries });
    this.commitPresentation();
  };

  printContent = (content: PresentationContent, id?: string): string =>
    this.printOutput({
      type: "log",
      message: content,
      timestamp: new Date(),
      ...(id === undefined ? {} : { id }),
    });
  private pinnedReasoningIds = new Set<EphemeralRegionId>();
  private collapseReasoning = true;
  private pendingOutputIdCounter = 0;
  private outputBatch: OutputEntryWithId[] = [];
  private batchFlushScheduled = false;
  private expandableDiff: ExpandableDiffPayload | null = null;
  private pendingReceiptDiffs = new Map<string, string>();
  private modeSwitchHandler: ModeSwitchHandler | null = null;
  private sessionCostUSD = 0;
  private sessionPromptTokens = 0;
  private sessionCompletionTokens = 0;
  private expandableReasoningStack: ExpandableReasoning[] = [];
  private inputHistory: string[] = [];
  private ephemeralRegions: Map<EphemeralRegionId, EphemeralRegion> = new Map();
  private ephemeralIdCounter = 0;
  private subagentRuns: Map<EphemeralRegionId, SubagentRun> = new Map();
  // A run may synchronously spawn nested runs. Interrupting only the top-most
  // callback leaves the parent waiting for (and potentially respawning) a child.
  // Keep the stack for scoped cleanup, but dispatch an interrupt to every active
  // run so Esc Esc always cancels the complete run tree.
  private interruptHandlerStack: Array<() => void> = [];
  private backgroundHandlerStack: Array<() => void> = [];
  private promptContinuation: ((result: PromptResult) => void) | null = null;
  private rendererFallbackHandler: (() => void) | null = null;
  /**
   * Streamed text passes through here on its way into the scrollback, so both
   * renderers show it at the same reading pace. Off until a renderer that
   * someone watches turns it on; a screen reader, a pipe and the tests get
   * every delta the moment it arrives.
   */
  private readonly streamPacer: StreamPacer = createStreamPacer(
    () => {
      const entry = this.document.entries.at(-1);
      if (entry === undefined || entry.id !== this.document.streamingId) return null;
      return entry.content.kind === "agent"
        ? { id: entry.id, text: entry.content.markdown }
        : entry.content.kind === "reasoning"
          ? { id: entry.id, text: entry.content.text }
          : null;
    },
    (id, length) => {
      if (id !== this.document.streamingId) return;
      this.streamReveal = { id, length };
      this.refreshClassicProjection();
      this.schedulePresentationCommit();
    },
  );
  private streamPacingEnabled = false;
  /** Folded reasoning of the turn in progress, printed as one line when it settles. */
  private turnThought: TurnThought = NO_THOUGHT;
  private turnThoughtLabel = "Reasoning";
  private readerFollowing = true;

  subscribeOutput = (listener: () => void): (() => void) => {
    this.getOutputSnapshot();
    this.classicSubscribers += 1;
    const unsubscribe = this.output.subscribe(listener);
    return () => {
      this.classicSubscribers -= 1;
      unsubscribe();
    };
  };
  getOutputSnapshot = (): OutputSnapshot => {
    if (this.classicDirty) this.computeClassicProjection(false);
    return this.output.getSnapshot();
  };

  subscribeSession = (listener: () => void): (() => void) => this.session.subscribe(listener);
  getSessionSnapshot = (): SessionSnapshot => this.session.getSnapshot();

  subscribePrompt = (listener: () => void): (() => void) => this.prompt.subscribe(listener);
  getPromptSlice = (): PromptSnapshot => this.prompt.getSnapshot();

  subscribeEphemeral = (listener: () => void): (() => void) => this.ephemeral.subscribe(listener);
  getEphemeralSnapshot = (): EphemeralSnapshot => this.ephemeral.getSnapshot();

  subscribeSubagents = (listener: () => void): (() => void) => this.subagents.subscribe(listener);
  getSubagentsSnapshot = (): SubagentsSnapshot => this.subagents.getSnapshot();

  private publishDocument(next: PresentationDocument): void {
    if (Object.is(next, this.document)) return;
    this.document = next;
    this.refreshClassicProjection();
    this.schedulePresentationCommit();
  }

  private refreshClassicProjection(): void {
    this.classicDirty = true;
    if (this.classicSubscribers > 0) {
      this.classicNotificationPending = true;
      this.schedulePresentationCommit();
    }
  }

  private computeClassicProjection(notify: boolean): void {
    this.classicDirty = false;
    this.classicProjection ??= createClassicProjection();
    const projected = this.classicProjection(this.document, this.documentGeneration, {
      expandedReasoningIds: this.expandedReasoningIds,
      liveReasoningIds: this.liveReasoningIds,
      hiddenReasoningIds: this.deferredReasoningIds,
      streamReveal: this.streamReveal,
    });
    const replayEntries = this.reasoningReplays.flatMap((replay) => {
      const sources = this.document.entries.filter(
        (entry) => replay.sourceIds.includes(entry.id) && entry.content.kind === "reasoning",
      );
      const content = sources[0]?.content;
      if (content?.kind !== "reasoning") return [];
      return [
        {
          id: replay.id,
          type: "streamContent" as const,
          message: {
            ...content,
            text: sources
              .map((entry) => (entry.content.kind === "reasoning" ? entry.content.text : ""))
              .join("\n\n"),
          },
          timestamp: new Date(sources[0]!.timestamp),
        },
      ];
    });
    this.output.set(
      {
        ...projected,
        entries: [...projected.entries, ...replayEntries],
        streaming: projected.pending?.rawTail ?? "",
        staticGeneration: this.documentGeneration,
      },
      notify,
    );
  }

  private flushOutputBatch = (): void => {
    if (!this.batchFlushScheduled) return;
    this.batchFlushScheduled = false;
    this.doFlushBatch();
  };

  private doFlushBatch(): void {
    if (this.outputBatch.length === 0) return;
    // A printed entry comes after everything streamed before it, so paced
    // text still held back lands first.
    this.streamPacer.flush();
    const batch = this.outputBatch;
    this.outputBatch = [];
    this.publishDocument(
      appendDocumentEntries(
        settleDocumentStream(this.document),
        batch.map((entry) => ({
          id: entry.id,
          content: contentFromOutput(entry),
          timestamp: entry.timestamp.toISOString(),
        })),
      ),
    );
  }

  flushOutputBatchNow(): void {
    if (this.batchFlushScheduled) {
      this.batchFlushScheduled = false;
    }
    this.doFlushBatch();
  }

  printOutput = (entry: OutputEntry): string => {
    const id = entry.id ?? `queued-output-${this.sourceNamespace}-${++this.pendingOutputIdCounter}`;
    const entryWithId: OutputEntryWithId = entry.id
      ? (entry as OutputEntryWithId)
      : { ...entry, id };
    this.outputBatch.push(entryWithId);
    this.schedulePresentationCommit();
    if (!this.batchFlushScheduled) {
      this.batchFlushScheduled = true;
      queueMicrotask(this.flushOutputBatch);
    }
    return id;
  };

  private updateOutputEntry(id: string, patch: OutputEntry): void {
    let found = false;
    const entries = this.document.entries.map((entry) => {
      if (entry.id !== id) return entry;
      found = true;
      return { id, content: contentFromOutput(patch), timestamp: patch.timestamp.toISOString() };
    });
    if (found)
      this.publishDocument({ ...this.document, revision: this.document.revision + 1, entries });
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
    if (!Number.isFinite(deltaUSD) || deltaUSD < 0) return;
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
    const handlers = this.interruptHandlerStack.slice();
    const interrupt =
      handlers.length === 0
        ? null
        : handlers.length === 1
          ? handlers[0]!
          : (): void => {
              // Run newest first so the currently visible child is stopped
              // immediately, then propagate to its parent and any ancestors.
              for (let index = handlers.length - 1; index >= 0; index -= 1) {
                handlers[index]?.();
              }
            };
    patchSlice(this.session, { interruptHandler: interrupt });
  };

  setBackgroundHandler = (handler: (() => void) | null): void => {
    if (handler === null) {
      this.backgroundHandlerStack.pop();
    } else {
      this.backgroundHandlerStack.push(handler);
    }
    const top = this.backgroundHandlerStack[this.backgroundHandlerStack.length - 1] ?? null;
    patchSlice(this.session, { backgroundHandler: top });
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

  /**
   * Pop the leading run of prose entries, leaving any slash/shell command at
   * the head (and everything behind it) queued. Used mid-run so a queued
   * command is never injected into the model conversation as text.
   */
  takeQueuedProse = (): readonly string[] => {
    const queue = this.prompt.getSnapshot().messageQueue;
    const firstCommand = queue.findIndex(isQueuedCommand);
    const end = firstCommand === -1 ? queue.length : firstCommand;
    if (end === 0) return EMPTY_QUEUE;
    patchSlice(this.prompt, { messageQueue: queue.slice(end) });
    return queue.slice(0, end);
  };

  /**
   * Pop the next turn: a command at the head runs alone, otherwise the
   * leading prose run is sent as one combined message.
   */
  takeQueuedTurn = (): readonly string[] => {
    const queue = this.prompt.getSnapshot().messageQueue;
    const head = queue[0];
    if (head === undefined) return EMPTY_QUEUE;
    if (!isQueuedCommand(head)) return this.takeQueuedProse();
    patchSlice(this.prompt, { messageQueue: queue.slice(1) });
    return [head];
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
    // A new turn starts the list over. Finished sub-agents stay readable between
    // turns, but the list is "this run's sub-agents", not the session's.
    if (busy && !this.session.getSnapshot().chatBusy) this.pruneFinishedSubagentRuns();
    const snapshot = this.session.getSnapshot();
    patchSlice(this.session, {
      chatBusy: busy,
      busySince: busy ? (snapshot.busySince ?? Date.now()) : null,
    });
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

  /**
   * A write/edit receipt's full diff, held until its card is answered. The
   * receipt itself cannot carry the text: the tool only sees the result after
   * the approval decision, so it arrives late. Both interfaces read it when
   * the receipt settles; nothing else may touch these ids.
   */
  setPendingReceiptDiff = (toolCallId: string, diffText: string): void => {
    this.pendingReceiptDiffs.set(toolCallId, diffText);
  };

  takePendingReceiptDiff = (toolCallId: string): string | undefined => {
    const diffText = this.pendingReceiptDiffs.get(toolCallId);
    if (diffText === undefined) return undefined;
    this.pendingReceiptDiffs.delete(toolCallId);
    return diffText;
  };

  clearPendingReceiptDiff = (toolCallId: string): void => {
    this.pendingReceiptDiffs.delete(toolCallId);
  };

  /**
   * Ctrl+E: expand the most recent settled write/edit receipt's full diff in
   * place (or collapse it). Walks back through older receipts when the newest
   * is already expanded, the way Ctrl+R walks the reasoning blocks. Returns
   * false when no receipt carries a diff to expand.
   */
  toggleLastReceiptDiff = (): boolean => {
    this.flushOutputBatchNow();
    const entries = this.output.getSnapshot().entries;
    const candidates: { id: string; expanded: boolean }[] = [];
    for (const entry of entries) {
      if (entry.type !== "log") continue;
      const receipt = entry.meta?.["toolReceipt"] as
        { readonly app?: unknown; readonly diffText?: unknown } | undefined;
      if (receipt === undefined || typeof receipt["app"] !== "string") continue;
      if (typeof receipt["diffText"] !== "string" || receipt["diffText"].length === 0) continue;
      candidates.push({ id: entry.id, expanded: entry.meta?.["expanded"] === true });
    }
    for (const candidate of candidates.reverse()) {
      const expanded = !candidate.expanded;
      const previous = this.output.getSnapshot();
      let found = false;
      const nextEntries = previous.entries.map((entry) => {
        if (entry.id !== candidate.id) return entry;
        found = true;
        return { ...entry, meta: { ...entry.meta, expanded } };
      });
      if (!found) continue;
      this.scrollback = { ...this.scrollback, staticEntries: nextEntries };
      this.output.set({ ...previous, entries: nextEntries });
      return true;
    }
    return false;
  };

  /**
   * The newest settled write/edit receipt's full diff, for the classic
   * scrollback to append below the transcript. Unaffected by later tool
   * results, because the diff rides on the receipt itself.
   */
  latestReceiptDiffText = (): string | undefined => {
    this.flushOutputBatchNow();
    let latest: string | undefined;
    for (const entry of this.output.getSnapshot().entries) {
      if (entry.type !== "log") continue;
      const receipt = entry.meta?.["toolReceipt"] as
        { readonly app?: unknown; readonly diffText?: unknown } | undefined;
      if (receipt === undefined || typeof receipt["app"] !== "string") continue;
      if (typeof receipt["diffText"] === "string" && receipt["diffText"].length > 0) {
        latest = receipt["diffText"];
      }
    }
    return latest;
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

  /**
   * `agentRun` marks a region that tracks a delegated agent, which is what gets it a
   * row in the sub-agent list; internal steps such as compaction leave it out.
   */
  openEphemeral = (
    kind: EphemeralKind,
    label: string,
    maxLines: number,
    agentRun?: { readonly task: string; readonly acceptsMessages: boolean },
  ): EphemeralRegionId => {
    const id = `eph-${this.sourceNamespace}-${++this.ephemeralIdCounter}`;
    const startedAt = Date.now();
    this.ephemeralRegions.set(id, {
      id,
      kind,
      label,
      startedAt,
      tail: [],
      maxLines,
    });
    if (kind === "reasoning") {
      this.liveReasoningIds.add(id);
      this.deferredReasoningIds.add(id);
      this.printOutput({
        id,
        type: "streamContent",
        message: { kind: "reasoning", text: "", label },
        timestamp: new Date(),
      });
      this.flushOutputBatchNow();
    }
    this.publishEphemeralRegions();
    if (agentRun !== undefined) {
      this.subagentRuns.set(id, openSubagentRun(id, label, startedAt, agentRun));
      this.publishSubagentRuns();
    }
    return id;
  };

  appendEphemeral = (
    id: EphemeralRegionId,
    text: string,
    channel: SubagentChannel = "response",
  ): void => {
    if (text.length === 0) return;
    const region = this.ephemeralRegions.get(id);
    if (!region) return;

    const run = this.subagentRuns.get(id);
    if (run !== undefined) {
      this.subagentRuns.set(id, appendToSubagentRun(run, text, channel));
      this.publishSubagentRuns();
    }

    const incoming = text.split("\n");
    const merged = [...region.tail];
    if (merged.length > 0 && incoming.length > 0) {
      merged[merged.length - 1] = (merged[merged.length - 1] ?? "") + (incoming.shift() ?? "");
    }
    for (const line of incoming) merged.push(line);

    const trimmed =
      merged.length > region.maxLines ? merged.slice(merged.length - region.maxLines) : merged;

    if (region.kind === "reasoning") {
      const source = this.document.entries.find((entry) => entry.id === id)?.content;
      const fullText = source?.kind === "reasoning" ? source.text + text : text;
      this.updateOutputEntry(id, {
        type: "streamContent",
        message: { kind: "reasoning", text: fullText, label: region.label },
        timestamp: new Date(),
      });
    }
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
    this.finishSubagentRunWith(id, summary.status ?? "completed");

    const accepted = this.document.entries.find((entry) => entry.id === id)?.content;
    const capturedText =
      summary.fullText?.trim() ||
      (accepted?.kind === "reasoning" ? accepted.text : region.tail.join("\n").trim());
    const pinned = this.pinnedReasoningIds.delete(id);
    const keepExpanded = pinned || !this.collapseReasoning;

    if (region.kind === "reasoning") {
      this.liveReasoningIds.delete(id);
      const source = this.document.entries.find((entry) => entry.id === id)?.content;
      const text =
        summary.fullText?.trim() || (source?.kind === "reasoning" ? source.text : capturedText);
      this.updateOutputEntry(id, {
        type: "streamContent",
        message: {
          kind: "reasoning",
          text,
          label: region.label,
          durationMs: summary.durationMs,
          ...(summary.tokens === undefined ? {} : { tokens: summary.tokens }),
        },
        timestamp: new Date(),
      });
      this.turnThoughtIds.push(id);
      if (keepExpanded && capturedText.length > 0) {
        this.expandedReasoningIds.add(id);
        this.deferredReasoningIds.delete(id);
        this.refreshClassicProjection();
        this.schedulePresentationCommit();
        return;
      }
      // Folded reasoning waits for the turn to settle, so the turn gets one
      // line however many times it thought (settleTurnThought).
      this.turnThought = addThoughtStep(this.turnThought, {
        durationMs: summary.durationMs,
        text: capturedText,
        ...(summary.tokens !== undefined && { tokens: summary.tokens }),
      });
      this.turnThoughtLabel = region.label;
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

  /**
   * Print the turn's folded reasoning as one line, and make it the block ctrl+r
   * opens. Called when a turn ends however it ends: an answer, an error, or an
   * interrupt. A turn that did not think prints nothing.
   */
  settleTurnThought = (): void => {
    const thought = this.turnThought;
    this.turnThought = NO_THOUGHT;
    for (const id of this.turnThoughtIds) this.deferredReasoningIds.delete(id);
    this.refreshClassicProjection();
    if (thought.steps === 0) {
      this.turnThoughtIds = [];
      return;
    }
    const fullText = thoughtText(thought);
    const ids = this.turnThoughtIds;
    this.turnThoughtIds = [];
    const entryId = ids[0];
    if (fullText.length > 0) {
      this.pushExpandableReasoning({
        fullText,
        label: this.turnThoughtLabel,
        durationMs: thought.durationMs,
        steps: thought.steps,
        ...(entryId === undefined ? {} : { entryId }),
        entryIds: ids,
        ...(thought.tokens !== undefined && { tokens: thought.tokens }),
      });
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

  /** Drops every recalled entry. Called when a different conversation hydrates. */
  clearInputHistory = (): void => {
    this.inputHistory = [];
  };

  private pushExpandableReasoning(value: ExpandableReasoning): void {
    this.expandableReasoningStack.push(value);
    if (this.expandableReasoningStack.length > MAX_EXPANDABLE_REASONING) {
      this.expandableReasoningStack.shift();
    }
    this.setExpandableReasoning(value);
  }

  /** The run was interrupted: every open region closes, and the turn's thinking settles. */
  collapseAllEphemeral = (): void => {
    for (const id of this.ephemeralRegions.keys()) this.finishSubagentRunWith(id, "interrupted");
    for (const region of Array.from(this.ephemeralRegions.values())) {
      if (region.kind !== "reasoning") continue;
      const content = this.document.entries.find((entry) => entry.id === region.id)?.content;
      if (content?.kind === "reasoning" && content.text.trim().length > 0)
        this.collapseEphemeral(region.id, { durationMs: Date.now() - region.startedAt });
      else {
        this.liveReasoningIds.delete(region.id);
        this.deferredReasoningIds.delete(region.id);
      }
    }
    if (this.ephemeralRegions.size > 0) {
      this.ephemeralRegions.clear();
      this.publishEphemeralRegions();
    }
    this.settleTurnThought();
  };

  private publishSubagentRuns(): void {
    const runs =
      this.subagentRuns.size === 0 ? EMPTY_SUBAGENT_RUNS : Array.from(this.subagentRuns.values());
    patchSlice(this.subagents, { runs });
  }

  private pruneFinishedSubagentRuns(): void {
    let pruned = false;
    for (const [id, run] of this.subagentRuns) {
      if (run.status === "running") continue;
      this.subagentRuns.delete(id);
      pruned = true;
    }
    if (pruned) this.publishSubagentRuns();
  }

  /**
   * A message still pending when the sub-agent ends never reached it: the loop only
   * reads them between tool batches, and there will be no next batch. Saying so is
   * the difference between "it ignored me" and "it never heard me".
   */
  private finishSubagentRunWith(
    id: EphemeralRegionId,
    status: Exclude<SubagentStatus, "running">,
  ): void {
    const run = this.subagentRuns.get(id);
    if (run === undefined || run.status !== "running") return;
    const undelivered = run.pendingMessages.length;
    this.subagentRuns.set(id, finishSubagentRun(run, status, Date.now()));
    this.publishSubagentRuns();
    if (undelivered > 0) {
      this.printOutput({
        type: "warn",
        message:
          undelivered === 1
            ? `Your message to ${run.label} was not delivered: it finished before its next step.`
            : `${String(undelivered)} messages to ${run.label} were not delivered: it finished before its next step.`,
        timestamp: new Date(),
      });
    }
  }

  recordSubagentToolStart = (
    id: EphemeralRegionId,
    tool: { readonly toolCallId: string; readonly name: string; readonly args: string },
  ): void => {
    const run = this.subagentRuns.get(id);
    if (run === undefined) return;
    this.subagentRuns.set(id, startSubagentTool(run, tool));
    this.publishSubagentRuns();
  };

  recordSubagentToolEnd = (
    id: EphemeralRegionId,
    toolCallId: string,
    outcome: { readonly failed: boolean; readonly summary: string; readonly durationMs: number },
  ): void => {
    const run = this.subagentRuns.get(id);
    if (run === undefined) return;
    this.subagentRuns.set(id, finishSubagentTool(run, toolCallId, outcome));
    this.publishSubagentRuns();
  };

  /** Queue a message for a running sub-agent. False when it has finished or cannot take one. */
  sendSubagentMessage = (id: EphemeralRegionId, message: string): boolean => {
    const run = this.subagentRuns.get(id);
    if (run === undefined) return false;
    const next = steerSubagentRun(run, message);
    if (next === null) return false;
    this.subagentRuns.set(id, next);
    this.publishSubagentRuns();
    return true;
  };

  takeSubagentMessage = (id: EphemeralRegionId): string | undefined => {
    const run = this.subagentRuns.get(id);
    if (run === undefined) return undefined;
    const taken = takeSubagentMessages(run);
    if (taken.message === undefined) return undefined;
    this.subagentRuns.set(id, taken.run);
    this.publishSubagentRuns();
    return taken.message;
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
    if (target === "in-place")
      for (const id of value.entryIds ?? (value.entryId === undefined ? [] : [value.entryId]))
        this.expandedReasoningIds.add(id);
    if (target === "in-place" && value.entryId !== undefined) {
      this.flushOutputBatchNow();
      this.refreshClassicProjection();
      this.schedulePresentationCommit();
    } else {
      const id = `${value.entryId ?? "reasoning"}:expanded:${String(this.reasoningReplays.length)}`;
      this.reasoningReplays.push({
        id,
        sourceIds: value.entryIds ?? (value.entryId === undefined ? [] : [value.entryId]),
      });
      this.expandedReasoningIds.add(id);
      this.refreshClassicProjection();
    }
    this.setExpandableReasoning(this.expandableReasoningStack.at(-1) ?? null);
    return true;
  };

  appendStream = (kind: StreamKind, delta: string): void => {
    if (delta.length === 0) return;
    this.flushOutputBatchNow();
    const last = this.document.entries.at(-1);
    const matching =
      last?.id === this.document.streamingId &&
      (kind === "response" ? last?.content.kind === "agent" : last?.content.kind === "reasoning");
    if (!matching) {
      this.streamPacer.flush();
      this.streamReveal = null;
    }
    this.applyStreamDelta(kind, delta);
    this.streamPacer.receive();
  };

  /**
   * Pace streamed text for someone reading it as it arrives. Turned on by the
   * renderer that is mounted, and left off for a screen reader, where text
   * that keeps growing is announced over and over.
   */
  setStreamPacing = (enabled: boolean): void => {
    this.streamPacingEnabled = enabled;
    this.streamPacer.setPaced(this.streamPacingEnabled && this.readerFollowing);
  };

  /**
   * Whether the reader can see the live edge. While they can't (scrolled up,
   * or an overlay covers the transcript) there is nobody to pace for, so the
   * answer is shown whole and what they come back to is complete.
   */
  setReaderFollowing = (following: boolean): void => {
    this.readerFollowing = following;
    this.streamPacer.setPaced(this.streamPacingEnabled && this.readerFollowing);
  };

  private applyStreamDelta(kind: StreamKind, delta: string): void {
    const next = appendDocumentStream(
      this.document,
      kind,
      delta,
      `output-${this.sourceNamespace}-${++this.pendingOutputIdCounter}`,
      new Date().toISOString(),
    );
    if (next.streamingId !== undefined && this.streamReveal?.id !== next.streamingId)
      this.streamReveal = { id: next.streamingId, length: 0 };
    this.publishDocument(next);
  }

  finalizeStream = (): void => {
    this.flushOutputBatchNow();
    this.streamPacer.end();
    this.streamReveal = null;
    this.publishDocument(settleDocumentStream(this.document));
  };

  clearOutputs = (): void => {
    this.streamPacer.reset();
    this.resetDocumentControls();
    this.outputBatch = [];
    this.batchFlushScheduled = false;
    this.documentGeneration += 1;
    this.publishDocument({
      id: `session:${String(this.documentGeneration)}`,
      revision: this.document.revision + 1,
      entries: [],
    });
  };

  private resetDocumentControls(): void {
    this.turnThought = NO_THOUGHT;
    this.reasoningReplays.length = 0;
    this.classicProjection = undefined;
    this.streamReveal = null;
    this.expandableReasoningStack = [];
    this.pinnedReasoningIds.clear();
    this.expandedReasoningIds.clear();
    this.liveReasoningIds.clear();
    this.deferredReasoningIds.clear();
    this.turnThoughtIds = [];
    this.ephemeralRegions.clear();
    this.publishEphemeralRegions();
    this.subagentRuns.clear();
    this.publishSubagentRuns();
    this.setExpandableReasoning(null);
  }

  /** Publish a data-only menu. Pass the continuation here, not on the snapshot. */
  setActiveMenu = (menu: ActiveMenu | null, onComplete?: (result: PromptResult) => void): void => {
    this.promptContinuation = menu === null ? null : (onComplete ?? null);
    patchSlice(this.session, { activeMenu: menu });
  };

  /**
   * Replace the published menu's data while keeping its continuation, for a surface that fills
   * in after it was first shown. A no-op when nothing is published, so a late refresh cannot
   * resurrect a menu that was already answered.
   */
  refreshActiveMenu = (menu: ActiveMenu): void => {
    if (this.session.getSnapshot().activeMenu === null) {
      return;
    }
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

  setRetryNotice = (notice: RetryNotice | null): void => {
    if (notice === null && this.session.getSnapshot().retryNotice === null) {
      return;
    }
    patchSlice(this.session, { retryNotice: notice });
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

export function useSubagentsSlice(): SubagentsSnapshot {
  return useSyncExternalStore(
    store.subscribeSubagents,
    store.getSubagentsSnapshot,
    store.getSubagentsSnapshot,
  );
}

export function useEphemeralSlice(): EphemeralSnapshot {
  return useSyncExternalStore(
    store.subscribeEphemeral,
    store.getEphemeralSnapshot,
    store.getEphemeralSnapshot,
  );
}

/** One committed snapshot for every fullscreen region. Prompt continuations remain separate. */
export function usePresentationSlice(): PresentationSnapshot {
  return useSyncExternalStore(
    store.subscribePresentation,
    store.getPresentationSnapshot,
    store.getPresentationSnapshot,
  );
}

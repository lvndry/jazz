import type React from "react";
import type { ActivityState } from "./activity-state";
import type { OutputEntry, PromptState } from "./types";

type PrintOutputHandler = (entry: OutputEntry) => string;

const MAX_PENDING_OUTPUT_QUEUE = 2000;

export class UIStore {
  // Output handlers
  private printOutputHandler: PrintOutputHandler | null = null;
  private clearOutputsHandler: (() => void) | null = null;
  private pendingOutputQueue: OutputEntry[] = [];
  private _pendingClear = false;
  private pendingOutputIdCounter = 0;

  // Snapshots (kept in sync so late-registering components can hydrate)
  private promptSnapshot: PromptState | null = null;
  private activitySnapshot: ActivityState = { phase: "idle" };
  private workingDirectorySnapshot: string | null = null;

  // React state setters (registered by island components)
  private promptSetter: ((prompt: PromptState | null) => void) | null = null;
  private activitySetter: ((activity: ActivityState) => void) | null = null;
  private workingDirectorySetter: ((wd: string | null) => void) | null = null;

  // ── Public API (called by consumers) ──────────────────────────────

  printOutput = (entry: OutputEntry): string => {
    const id = entry.id ?? `queued-output-${++this.pendingOutputIdCounter}`;
    const entryWithId = entry.id ? entry : { ...entry, id };

    if (!this.printOutputHandler) {
      if (this.pendingOutputQueue.length < MAX_PENDING_OUTPUT_QUEUE) {
        this.pendingOutputQueue.push(entryWithId);
      }
      return id;
    }
    return this.printOutputHandler(entryWithId);
  };

  setPrompt = (prompt: PromptState | null): void => {
    this.promptSnapshot = prompt;
    if (this.promptSetter) {
      this.promptSetter(prompt);
    }
  };

  setActivity = (activity: ActivityState): void => {
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

  setCustomView = (_view: React.ReactNode | null): void => {};

  setInterruptHandler = (_handler: (() => void) | null): void => {};

  clearOutputs = (): void => {
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

  registerCustomView(setter: (view: React.ReactNode | null) => void): void {
    this.setCustomView = setter;
  }

  registerInterruptHandler(setter: (handler: (() => void) | null) => void): void {
    this.setInterruptHandler = setter;
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

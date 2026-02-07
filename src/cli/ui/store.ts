import type React from "react";
import type { ActivityState } from "./activity-state";
import type { LogEntryInput, PromptState } from "./types";

type PrintOutputHandler = (entry: LogEntryInput) => string;

const MAX_PENDING_LOG_QUEUE = 5000;

export class UIStore {
  // Log handlers
  private printOutputHandler: PrintOutputHandler | null = null;
  private clearLogsHandler: (() => void) | null = null;
  private pendingLogQueue: LogEntryInput[] = [];
  private _pendingClear = false;
  private pendingLogIdCounter = 0;

  // Snapshots (kept in sync so late-registering components can hydrate)
  private promptSnapshot: PromptState | null = null;
  private activitySnapshot: ActivityState = { phase: "idle" };
  private workingDirectorySnapshot: string | null = null;

  // React state setters (registered by island components)
  private promptSetter: ((prompt: PromptState | null) => void) | null = null;
  private activitySetter: ((activity: ActivityState) => void) | null = null;
  private workingDirectorySetter: ((wd: string | null) => void) | null = null;

  // ── Public API (called by consumers) ──────────────────────────────

  printOutput = (entry: LogEntryInput): string => {
    const id = entry.id ?? `queued-log-${++this.pendingLogIdCounter}`;
    const entryWithId = entry.id ? entry : { ...entry, id };

    if (!this.printOutputHandler) {
      if (this.pendingLogQueue.length < MAX_PENDING_LOG_QUEUE) {
        this.pendingLogQueue.push(entryWithId);
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

  clearLogs = (): void => {
    if (!this.clearLogsHandler) {
      this._pendingClear = true;
      this.pendingLogQueue.length = 0;
      return;
    }
    this.clearLogsHandler();
  };

  // ── Registration methods (called by island components) ────────────

  registerPrintOutput(handler: PrintOutputHandler): void {
    this.printOutputHandler = handler;
  }

  registerClearLogs(handler: () => void): void {
    this.clearLogsHandler = handler;
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

  drainPendingLogQueue(): LogEntryInput[] {
    return this.pendingLogQueue.splice(0, this.pendingLogQueue.length);
  }
}

export const store = new UIStore();

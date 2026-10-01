/**
 * The bookkeeping behind a run's browser tabs, kept apart from Chrome so it can be reasoned about
 * and tested without one: which names exist, which tab is active, how many may be open, which
 * snapshot refs are still good, and which of a user's own tabs a hint names.
 */

import type { SnapshotRef } from "./snapshot";

/** The tab a run starts with, and the one a navigation opens when no tab exists yet. */
export const DEFAULT_TAB_NAME = "main";

/** Longest a tab name may be: a short handle the model types back, never a description. */
export const MAX_TAB_NAME_LENGTH = 32;

/** Lowercase words joined by single hyphens, like the names of typed secrets. */
export const TAB_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Most tabs one run holds open. Every tab is its own renderer process in Chrome, and the model
 * tracks tabs by name in its own context, so a handful covers real tasks (a site, its login, a
 * reference page) and a runaway loop cannot open hundreds.
 */
export const MAX_TABS = 8;

/** Longest hint an adoption request may carry to name one of the user's own tabs. */
export const MAX_ADOPTION_HINT_LENGTH = 100;

export function tabNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_TAB_NAME_LENGTH || !TAB_NAME_PATTERN.test(name)) {
    return `A tab name is lowercase words joined by hyphens, up to ${String(MAX_TAB_NAME_LENGTH)} characters, such as "checkout".`;
  }
  return undefined;
}

/** A run's named tabs, at most `limit` of them, with one active. */
export class TabRegistry<Tab> {
  private readonly tabs = new Map<string, Tab>();
  private activeName: string | undefined;

  constructor(private readonly limit: number = MAX_TABS) {}

  get size(): number {
    return this.tabs.size;
  }

  names(): readonly string[] {
    return [...this.tabs.keys()];
  }

  has(name: string): boolean {
    return this.tabs.has(name);
  }

  get(name: string): Tab | undefined {
    return this.tabs.get(name);
  }

  entries(): readonly (readonly [string, Tab])[] {
    return [...this.tabs.entries()];
  }

  /** The active tab's name, or undefined when no tab is open. */
  active(): string | undefined {
    return this.activeName;
  }

  /** Why `name` cannot be opened now, or undefined when it can. */
  problemAdding(name: string): string | undefined {
    const problem = tabNameProblem(name);
    if (problem !== undefined) {
      return problem;
    }
    if (this.tabs.has(name)) {
      return `A tab named "${name}" is already open.`;
    }
    if (this.tabs.size >= this.limit) {
      return `This run already has ${String(this.limit)} tabs open. Close one with browser_tabs before opening another.`;
    }
    return undefined;
  }

  /** Register `tab` under `name` and make it active. */
  add(name: string, tab: Tab): void {
    const problem = this.problemAdding(name);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    this.tabs.set(name, tab);
    this.activeName = name;
  }

  /** Make `name` the active tab and return it. */
  activate(name: string): Tab {
    const tab = this.tabs.get(name);
    if (tab === undefined) {
      throw new Error(this.unknownTabMessage(name));
    }
    this.activeName = name;
    return tab;
  }

  /**
   * Give the tab named `from` the name `to`, keeping its place in the order and its active
   * status.
   */
  rename(from: string, to: string): void {
    const tab = this.tabs.get(from);
    if (tab === undefined) {
      throw new Error(this.unknownTabMessage(from));
    }
    const problem =
      tabNameProblem(to) ??
      (this.tabs.has(to) ? `A tab named "${to}" is already open.` : undefined);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    const renamed = [...this.tabs.entries()].map(
      ([name, entry]) => [name === from ? to : name, entry] as const,
    );
    this.tabs.clear();
    for (const [name, entry] of renamed) {
      this.tabs.set(name, entry);
    }
    if (this.activeName === from) {
      this.activeName = to;
    }
  }

  /**
   * Forget `name` and return its tab. When it was the active tab, the most recently opened
   * remaining tab becomes active, or none does.
   */
  remove(name: string): Tab {
    const tab = this.tabs.get(name);
    if (tab === undefined) {
      throw new Error(this.unknownTabMessage(name));
    }
    this.tabs.delete(name);
    if (this.activeName === name) {
      this.activeName = [...this.tabs.keys()].at(-1);
    }
    return tab;
  }

  private unknownTabMessage(name: string): string {
    const open = this.names();
    return open.length === 0
      ? `No tab named "${name}": no tab is open. Use browser_navigate to open one.`
      : `No tab named "${name}". Open tabs: ${open.join(", ")}.`;
  }
}

export type RefLookup =
  | { readonly kind: "ok"; readonly backendNodeId: number; readonly label: string }
  | { readonly kind: "stale" }
  | { readonly kind: "missing" };

export const STALE_REF_MESSAGE =
  "The page changed since the last snapshot. Take a new browser_snapshot and use a ref from it.";

export function missingRefMessage(ref: string): string {
  return `No element has ref ${ref}. Take a new snapshot and use a ref from it.`;
}

/** The refs of a tab's latest snapshot, good until its page navigates. */
export class RefTable {
  private refs: ReadonlyMap<string, SnapshotRef> = new Map();
  private stale = false;
  private revision = 0;

  /** Adopt the refs of a snapshot taken just now. Bumping the revision is what tells an approval apart from the page it was shown for. */
  replace(refs: ReadonlyMap<string, SnapshotRef>): void {
    this.refs = refs;
    this.stale = false;
    this.revision += 1;
  }

  /** Refuse every ref until the next snapshot: the page the refs describe is gone. */
  invalidate(): void {
    this.stale = true;
    this.revision += 1;
  }

  /** Identity of the snapshot this table holds: approvals bind to it and reject a change. */
  get pageRevision(): number {
    return this.revision;
  }

  lookup(ref: string): RefLookup {
    const found = this.refs.get(ref);
    if (found === undefined) {
      return { kind: "missing" };
    }
    if (this.stale) {
      return { kind: "stale" };
    }
    return { kind: "ok", backendNodeId: found.backendNodeId, label: found.label };
  }
}

export interface AdoptionCandidate<Page> {
  readonly page: Page;
  readonly title: string;
  readonly url: string;
}

/** The candidates whose title or address contains `hint`, ignoring case. */
export function matchAdoptionCandidates<Page>(
  candidates: readonly AdoptionCandidate<Page>[],
  hint: string,
): readonly AdoptionCandidate<Page>[] {
  const wanted = hint.trim().toLowerCase();
  if (wanted === "") {
    return [];
  }
  return candidates.filter(
    (candidate) =>
      candidate.title.toLowerCase().includes(wanted) ||
      candidate.url.toLowerCase().includes(wanted),
  );
}

/**
 * What memory gained, lost and changed between two snapshots, so `/learn` can show the person
 * and the curation step what the session did to the store.
 */

import { storedClaimText } from "./source-trust";
import type { MemoryEntrySnapshot } from "../interfaces/memory-service";

/** One entry as a snapshot saw it: what it says first, and a hash that changes on any edit. */
export interface MemoryEntryState {
  readonly summary: string;
  readonly contentHash: string;
}

/** Entries keyed by scope-qualified path. */
export type MemoryState = ReadonlyMap<string, MemoryEntryState>;

export interface MemoryEntryChange {
  readonly path: string;
  readonly summary: string;
}

export interface SessionMemoryChanges {
  readonly added: readonly MemoryEntryChange[];
  readonly changed: readonly MemoryEntryChange[];
  readonly removed: readonly MemoryEntryChange[];
}

export function memoryStateFromSnapshot(entries: readonly MemoryEntrySnapshot[]): MemoryState {
  return new Map(
    entries.map((entry) => [
      entry.path,
      { summary: storedClaimText(entry.summary).trim(), contentHash: entry.entryContentHash },
    ]),
  );
}

/** Changed entries report their current first line; removed ones the line they had. */
export function diffMemoryStates(before: MemoryState, after: MemoryState): SessionMemoryChanges {
  const added: MemoryEntryChange[] = [];
  const changed: MemoryEntryChange[] = [];
  const removed: MemoryEntryChange[] = [];
  for (const [path, current] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      added.push({ path, summary: current.summary });
    } else if (previous.contentHash !== current.contentHash) {
      changed.push({ path, summary: current.summary });
    }
  }
  for (const [path, previous] of before) {
    if (!after.has(path)) {
      removed.push({ path, summary: previous.summary });
    }
  }
  const byPath = (left: MemoryEntryChange, right: MemoryEntryChange) =>
    left.path.localeCompare(right.path);
  return {
    added: added.sort(byPath),
    changed: changed.sort(byPath),
    removed: removed.sort(byPath),
  };
}

export function hasSessionMemoryChanges(changes: SessionMemoryChanges): boolean {
  return changes.added.length + changes.changed.length + changes.removed.length > 0;
}

/** One line per change, grouped, for the curation step's prompt. */
export function describeSessionMemoryChanges(changes: SessionMemoryChanges): string {
  if (!hasSessionMemoryChanges(changes)) {
    return "No memory entries were added, changed or removed during this session.";
  }
  const groups: Array<[string, readonly MemoryEntryChange[]]> = [
    ["Added", changes.added],
    ["Changed", changes.changed],
    ["Removed", changes.removed],
  ];
  return groups
    .filter(([, entries]) => entries.length > 0)
    .map(
      ([label, entries]) =>
        `${label}:\n${entries.map((entry) => `- ${entry.path}: ${entry.summary}`).join("\n")}`,
    )
    .join("\n\n");
}

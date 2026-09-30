/**
 * The agent's plan as every renderer shows it: a mark and a weight per item, the `N of M`
 * progress, and which slice of a long plan fits the room there is.
 *
 * A plan item reads by mark and weight, not by a colour per status: done is muted and struck
 * through, the current step is bold, and what is still to come is quiet. A completed item that
 * nothing verified keeps a different mark from one that was checked, because "I wrote it" and
 * "I ran it and it passed" are different claims. Warning amber never means "not started yet".
 */

import type { TodoSnapshotItem } from "../activity-state";
import type { GlyphSet } from "../glyphs";
import type { RoleSegment, TextRole } from "../text/roles";

export type TodoMarkKind = "done" | "unverified" | "active" | "cancelled" | "pending";

export interface TodoLine {
  readonly kind: TodoMarkKind;
  readonly mark: RoleSegment;
  readonly content: RoleSegment;
  readonly strikethrough: boolean;
  readonly bold: boolean;
}

export function todoMarkKind(todo: TodoSnapshotItem): TodoMarkKind {
  switch (todo.status) {
    case "completed":
      return todo.verifiedBy === undefined ? "unverified" : "done";
    case "in_progress":
      return "active";
    case "cancelled":
      return "cancelled";
    case "pending":
      return "pending";
  }
}

function markFor(kind: TodoMarkKind, glyphs: GlyphSet): RoleSegment {
  switch (kind) {
    case "done":
      return { text: glyphs.todoDone, role: "success" };
    case "unverified":
      return { text: glyphs.warn, role: "warning" };
    case "active":
      return { text: glyphs.todoActive, role: "accent" };
    case "cancelled":
      return { text: glyphs.todoCancelled, role: "muted" };
    case "pending":
      return { text: glyphs.todoPending, role: "muted" };
  }
}

function contentRole(kind: TodoMarkKind): TextRole {
  return kind === "active" ? "text" : "muted";
}

/** One plan item as its mark, its text and how the text is set. */
export function todoLine(todo: TodoSnapshotItem, glyphs: GlyphSet): TodoLine {
  const kind = todoMarkKind(todo);
  return {
    kind,
    mark: markFor(kind, glyphs),
    content: { text: todo.content, role: contentRole(kind) },
    strikethrough: kind === "done" || kind === "unverified" || kind === "cancelled",
    bold: kind === "active",
  };
}

/**
 * The plan as it reads once no run is driving it. A step still marked in progress belongs to a
 * run that ended (stopped, failed, cancelled) without finishing it, so it drops back to pending
 * instead of keeping a moving mark for work nobody is doing.
 */
export function settledPlan(todos: readonly TodoSnapshotItem[]): readonly TodoSnapshotItem[] {
  if (!todos.some((todo) => todo.status === "in_progress")) return todos;
  return todos.map((todo) =>
    todo.status === "in_progress" ? { ...todo, status: "pending" } : todo,
  );
}

/** `✓ Check status`: an item as plain text, for a receipt's detail and plain output. */
export function todoPlainLine(todo: TodoSnapshotItem, glyphs: GlyphSet): string {
  const line = todoLine(todo, glyphs);
  return `${line.mark.text} ${line.content.text}`;
}

/** The plan's heading and its progress: `plan`, `2 of 5`. Done counts every completed item. */
export function planProgress(todos: readonly TodoSnapshotItem[]): {
  readonly label: string;
  readonly progress: string;
} {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return { label: "plan", progress: `${String(done)} of ${String(todos.length)}` };
}

export interface PlanWindow {
  /** Index of the first item shown. */
  readonly start: number;
  readonly items: readonly TodoSnapshotItem[];
  /** Items after the window that did not fit, for a `+N more` line. */
  readonly overflow: number;
}

/**
 * The slice of a plan that fits `slots` rows. The window sits just before the first item still
 * in play, so the item that just finished keeps its mark on screen for one more update before
 * the next pending one slides in; a `+N more` line takes one slot when the rest do not fit.
 */
export function planWindow(todos: readonly TodoSnapshotItem[], slots: number): PlanWindow {
  if (slots <= 0 || todos.length === 0) {
    return { start: 0, items: [], overflow: 0 };
  }
  const firstIncomplete = todos.findIndex((todo) => todo.status !== "completed");
  const anchor = firstIncomplete < 0 ? -1 : Math.max(0, firstIncomplete - 1);
  const start = anchor < 0 ? Math.max(0, todos.length - slots) : anchor;
  const remaining = todos.length - start - slots;
  const shown = remaining > 0 ? slots - 1 : slots;
  const items = todos.slice(start, start + Math.max(0, shown));
  return { start, items, overflow: todos.length - start - items.length };
}

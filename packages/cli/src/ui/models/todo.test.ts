import { describe, expect, it } from "bun:test";
import type { TodoSnapshotItem } from "../activity-state";
import { getGlyphs } from "../glyphs";
import {
  planProgress,
  planWindow,
  settledPlan,
  todoLine,
  todoMarkKind,
  todoPlainLine,
} from "./todo";

const glyphs = getGlyphs();

function todo(overrides: Partial<TodoSnapshotItem> & { content: string }): TodoSnapshotItem {
  return { status: "pending", ...overrides };
}

describe("todoMarkKind", () => {
  it("tells a checked completion from one nothing verified", () => {
    expect(todoMarkKind(todo({ content: "a", status: "completed", verifiedBy: "tests" }))).toBe(
      "done",
    );
    expect(todoMarkKind(todo({ content: "a", status: "completed" }))).toBe("unverified");
  });

  it("maps the rest of the statuses one to one", () => {
    expect(todoMarkKind(todo({ content: "a", status: "in_progress" }))).toBe("active");
    expect(todoMarkKind(todo({ content: "a", status: "cancelled" }))).toBe("cancelled");
    expect(todoMarkKind(todo({ content: "a", status: "pending" }))).toBe("pending");
  });
});

describe("todoLine", () => {
  it("strikes through anything settled, but keeps the active item plain and bold", () => {
    const done = todoLine(
      todo({ content: "shipped", status: "completed", verifiedBy: "ci" }),
      glyphs,
    );
    expect(done.strikethrough).toBe(true);
    expect(done.bold).toBe(false);
    expect(done.mark.role).toBe("success");

    const unverified = todoLine(todo({ content: "claimed", status: "completed" }), glyphs);
    expect(unverified.strikethrough).toBe(true);
    expect(unverified.mark.role).toBe("warning");

    const active = todoLine(todo({ content: "working", status: "in_progress" }), glyphs);
    expect(active.strikethrough).toBe(false);
    expect(active.bold).toBe(true);
    expect(active.content.role).toBe("text");

    const pending = todoLine(todo({ content: "later", status: "pending" }), glyphs);
    expect(pending.strikethrough).toBe(false);
    expect(pending.bold).toBe(false);
    expect(pending.content.role).toBe("muted");
  });

  it("prints the mark and the text as one plain line", () => {
    const item = todo({ content: "reticulate splines", status: "in_progress" });
    expect(todoPlainLine(item, glyphs)).toBe(`${glyphs.todoActive} reticulate splines`);
  });
});

describe("planProgress", () => {
  it("counts only completed items toward the total", () => {
    const todos = [
      todo({ content: "a", status: "completed", verifiedBy: "x" }),
      todo({ content: "b", status: "completed" }),
      todo({ content: "c", status: "in_progress" }),
      todo({ content: "d", status: "pending" }),
    ];
    expect(planProgress(todos)).toEqual({ label: "plan", progress: "2 of 4" });
  });
});

describe("planWindow", () => {
  const todos = Array.from({ length: 8 }, (_, index) =>
    todo({ content: `step ${String(index)}`, status: index < 3 ? "completed" : "pending" }),
  );

  it("returns nothing when there is no room or nothing to show", () => {
    expect(planWindow(todos, 0)).toEqual({ start: 0, items: [], overflow: 0 });
    expect(planWindow([], 5)).toEqual({ start: 0, items: [], overflow: 0 });
  });

  it("holds back one slot so the item that just finished stays visible", () => {
    const window = planWindow(todos, 4);
    // firstIncomplete is index 3, so the anchor sits one item earlier at 2.
    expect(window.start).toBe(2);
    expect(window.items.map((item) => item.content)).toEqual(["step 2", "step 3", "step 4"]);
    expect(window.overflow).toBe(3);
  });

  it("shows the whole plan without an overflow row when it fits", () => {
    const short = Array.from({ length: 5 }, (_, index) =>
      todo({ content: `step ${String(index)}`, status: "pending" }),
    );
    const window = planWindow(short, 8);
    expect(window).toEqual({ start: 0, items: short, overflow: 0 });
  });

  it("still anchors before the current step even when the rest would otherwise fit", () => {
    // 8 slots for 8 items, but the window still opens one before the first incomplete
    // item rather than showing everything, so the just-finished item stays visible.
    const window = planWindow(todos, 8);
    expect(window.start).toBe(2);
    expect(window.items).toHaveLength(6);
    expect(window.overflow).toBe(0);
  });

  it("anchors to the tail once everything is done", () => {
    const finished = todos.map((item) => ({ ...item, status: "completed" as const }));
    const window = planWindow(finished, 3);
    expect(window.start).toBe(5);
    expect(window.overflow).toBe(0);
  });
});

describe("settledPlan", () => {
  it("drops a step still in progress back to pending and leaves the rest", () => {
    const todos: TodoSnapshotItem[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ];
    expect(settledPlan(todos).map((todo) => todo.status)).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
  });

  it("returns the same list when nothing is in progress", () => {
    const todos: TodoSnapshotItem[] = [{ content: "a", status: "completed" }];
    expect(settledPlan(todos)).toBe(todos);
  });
});

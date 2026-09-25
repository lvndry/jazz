import { describe, expect, test } from "bun:test";
import { getGlyphs } from "../glyphs";
import { openSubagentRun, startSubagentTool, steerSubagentRun } from "../subagent-runs";
import { subagentBlocks } from "./subagent-view";
import { SUBAGENT_LIST_MAX_ITEMS, subagentListRows } from "./SubagentList";
import type { SubagentListItem, SubagentListModel } from "./types";

const VIEWPORT = { width: 80, height: 24 };

function item(index: number, status: SubagentListItem["status"] = "running"): SubagentListItem {
  return {
    id: `eph-${String(index)}`,
    label: `Agent ${String(index)}`,
    status,
    activity: "",
    elapsedMs: 0,
  };
}

function rowText(model: SubagentListModel): string[] {
  return subagentListRows(model, VIEWPORT, getGlyphs()).map((row) =>
    row.segments
      .map((segment) => segment.text)
      .join("")
      .trimEnd(),
  );
}

describe("subagent list rows", () => {
  test("draws nothing when the turn delegated nothing", () => {
    expect(subagentListRows({ items: [] }, VIEWPORT)).toEqual([]);
    expect(subagentListRows(undefined, VIEWPORT)).toEqual([]);
  });

  test("every row is exactly the viewport's width", () => {
    const rows = subagentListRows({ items: [item(1), item(2, "completed")] }, VIEWPORT);
    for (const row of rows) {
      expect(row.segments.map((segment) => segment.text).join("")).toHaveLength(VIEWPORT.width);
    }
  });

  test("shrinks to its header once every agent has finished, until asked", () => {
    const finished = { items: [item(1, "completed"), item(2, "failed")] };
    expect(rowText(finished)).toHaveLength(1);
    expect(rowText(finished)[0]).toContain("2 subagents finished");
    expect(rowText({ ...finished, selected: 0 })).toHaveLength(3);
  });

  test("counts the running ones in the header", () => {
    expect(rowText({ items: [item(1), item(2, "completed")] })[0]).toContain(
      "1 of 2 subagents running",
    );
  });

  test("windows a long fan-out around the selection and names what is hidden", () => {
    const items = Array.from({ length: SUBAGENT_LIST_MAX_ITEMS + 3 }, (_, index) => item(index));
    const rows = rowText({ items, selected: items.length - 1 });
    expect(rows).toHaveLength(1 + SUBAGENT_LIST_MAX_ITEMS);
    expect(rows.at(-2)).toContain(`Agent ${String(items.length - 1)}`);
    expect(rows.at(-1)).toContain("+4 more");
  });
});

describe("subagent blocks", () => {
  test("lays out the heading, the brief, and the work in order", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, {
      task: "Solve the board",
      acceptsMessages: true,
    });
    run = startSubagentTool(run, { toolCallId: "call-1", name: "read_file", args: "board.txt" });
    run = steerSubagentRun(run, "try 7")!;
    const blocks = subagentBlocks(run, 3000);
    expect(blocks.map((block) => block.kind)).toEqual(["divider", "user", "tool", "user"]);
    expect(blocks[0]).toMatchObject({ kind: "divider", label: expect.stringContaining("Solver") });
    expect(blocks[2]).toMatchObject({ app: "read_file", args: "board.txt", summary: "running" });
  });
});

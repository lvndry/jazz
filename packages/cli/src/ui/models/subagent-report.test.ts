import { describe, expect, test } from "bun:test";
import { UIStore } from "../store";
import { appendToSubagentRun, openSubagentRun, startSubagentTool } from "../subagent-runs";
import { formatSubagentRun, resolveSubagentRun, subagentReport } from "./subagent-report";

describe("subagent report", () => {
  const run = startSubagentTool(
    appendToSubagentRun(
      openSubagentRun("eph-1", "Solver", 0, { task: "Solve it", acceptsMessages: false }),
      "The answer is 42",
      "response",
    ),
    { toolCallId: "c1", name: "read_file", args: "a.txt" },
  );

  test("numbers and prefix-resolves runs", () => {
    const other = openSubagentRun("eph-2", "Other", 0, { task: "", acceptsMessages: false });
    expect(resolveSubagentRun([run, other], "2")?.id).toBe("eph-2");
    expect(resolveSubagentRun([run, other], "eph-1")?.id).toBe("eph-1");
    expect(resolveSubagentRun([run, other], "eph")).toBeUndefined();
    expect(formatSubagentRun(run, 1, 5000)).toContain("1. Solver · running · 5s");
  });

  test("reports the brief and the log", () => {
    const report = subagentReport(run, 5000);
    expect(report.label).toBe("Solver");
    expect(report.rows).toContainEqual({ kind: "text", text: "Solve it" });
    expect(report.rows).toContainEqual({ kind: "text", text: "The answer is 42" });
  });
});

describe("store archive", () => {
  test("a new turn delists finished runs but /subagents still reads them", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Done", 12, { task: "t", acceptsMessages: true });
    store.collapseEphemeral(id, { durationMs: 5 });
    store.setChatBusy(true);
    expect(store.getSubagentsSnapshot().runs).toHaveLength(0);
    expect(store.getAllSubagentRuns().map((run) => run.id)).toEqual([id]);
  });
});

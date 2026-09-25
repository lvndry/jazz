import { describe, expect, test } from "bun:test";
import { UIStore } from "./store";
import {
  appendToSubagentRun,
  finishSubagentRun,
  finishSubagentTool,
  MAX_SUBAGENT_ENTRIES,
  openSubagentRun,
  startSubagentTool,
  steerSubagentRun,
  takeSubagentMessages,
} from "./subagent-runs";

function steerable(task = "Do the task"): { task: string; acceptsMessages: boolean } {
  return { task, acceptsMessages: true };
}

describe("subagent runs", () => {
  test("merges streamed pieces of one channel and splits on a change of channel", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable("Solve it"));
    run = appendToSubagentRun(run, "Let me ", "reasoning");
    run = appendToSubagentRun(run, "think", "reasoning");
    run = appendToSubagentRun(run, "\nThe answer", "response");
    run = appendToSubagentRun(run, " is 42", "response");
    expect(run.entries).toEqual([
      { kind: "reasoning", text: "Let me think" },
      { kind: "response", text: "The answer is 42" },
    ]);
    expect(run.activity).toBe("The answer is 42");
  });

  test("summarizes with the newest line that says something, not a closing fence", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable());
    run = appendToSubagentRun(run, "Output:\n```\nbeta\n```\n", "response");
    expect(run.activity).toBe("beta");
  });

  test("does not let a step's metrics note replace what the step was doing", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable());
    run = appendToSubagentRun(run, "Checking box six", "response");
    run = appendToSubagentRun(run, "\n+ 5.9s · 15k in → 163 out", "note");
    expect(run.activity).toBe("Checking box six");
  });

  test("keeps tool text out of the entries, since the call is recorded structurally", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable());
    run = startSubagentTool(run, { toolCallId: "call-1", name: "Read", args: "board.txt" });
    run = appendToSubagentRun(run, "\nRead board.txt", "tail");
    run = finishSubagentTool(run, "call-1", { failed: false, summary: "81 cells", durationMs: 12 });
    expect(run.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "call-1",
        name: "Read",
        args: "board.txt",
        status: "ok",
        summary: "81 cells",
        durationMs: 12,
      },
    ]);
    expect(run.activity).toBe("81 cells");
  });

  test("settles each parallel tool call by its own id", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable());
    run = startSubagentTool(run, { toolCallId: "a", name: "Read", args: "one" });
    run = startSubagentTool(run, { toolCallId: "b", name: "Read", args: "two" });
    run = finishSubagentTool(run, "b", { failed: true, summary: "missing", durationMs: 3 });
    expect(run.entries.map((entry) => (entry.kind === "tool" ? entry.status : entry.kind))).toEqual(
      ["running", "failed"],
    );
  });

  test("drops the oldest entries past the cap", () => {
    let run = openSubagentRun("eph-1", "Solver", 0, steerable());
    for (let index = 0; index <= MAX_SUBAGENT_ENTRIES; index++) {
      run = startSubagentTool(run, { toolCallId: String(index), name: "Read", args: "" });
    }
    expect(run.entries).toHaveLength(MAX_SUBAGENT_ENTRIES);
    expect(run.entries[0]).toMatchObject({ toolCallId: "1" });
  });

  test("queues steering only while running, and hands it over once", () => {
    const run = openSubagentRun("eph-1", "Solver", 0, steerable());
    const steered = steerSubagentRun(steerSubagentRun(run, "first")!, "  second  ")!;
    expect(steered.entries.filter((entry) => entry.kind === "steer")).toHaveLength(2);
    const taken = takeSubagentMessages(steered);
    expect(taken.message).toBe("first\n\nsecond");
    expect(takeSubagentMessages(taken.run).message).toBeUndefined();

    expect(steerSubagentRun(run, "   ")).toBeNull();
    expect(steerSubagentRun(finishSubagentRun(run, "completed", 10), "late")).toBeNull();
  });
});

describe("UIStore sub-agent runs", () => {
  test("tracks a sub-agent region from open through collapse, and keeps it afterwards", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Solver", 12, steerable("Solve the board"));
    store.appendEphemeral(id, "Working", "response");
    store.collapseEphemeral(id, { durationMs: 5, status: "failed" });

    const [run] = store.getSubagentsSnapshot().runs;
    expect(run).toMatchObject({ id, label: "Solver", task: "Solve the board", status: "failed" });
    expect(store.getEphemeralRegionsSnapshot()).toHaveLength(0);
  });

  test("lists only regions that track a delegated agent", () => {
    const store = new UIStore();
    store.openEphemeral("reasoning", "Reasoning", 8);
    store.openEphemeral("subagent", "Compacting 40 messages", 12);
    expect(store.getSubagentsSnapshot().runs).toHaveLength(0);
  });

  test("refuses a message for a run that has no step at which to read it", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Eyes", 12, {
      task: "Describe the image",
      acceptsMessages: false,
    });
    expect(store.sendSubagentMessage(id, "look left")).toBe(false);
    expect(store.getSubagentsSnapshot().runs[0]?.entries).toEqual([]);
  });

  test("keeps panel-only status lines out of the run's log", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Solver", 12, steerable("Solve the board"));
    store.appendEphemeral(id, "Task: Solve the board", "tail");
    expect(store.getSubagentsSnapshot().runs[0]?.entries).toEqual([]);
    expect(store.getEphemeralRegionsSnapshot()[0]?.tail).toEqual(["Task: Solve the board"]);
  });

  test("delivers a steering message to the running sub-agent and refuses a finished one", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Solver", 12, steerable());
    expect(store.sendSubagentMessage(id, "use backtracking")).toBe(true);
    expect(store.takeSubagentMessage(id)).toBe("use backtracking");
    expect(store.takeSubagentMessage(id)).toBeUndefined();

    store.collapseEphemeral(id, { durationMs: 5 });
    expect(store.sendSubagentMessage(id, "too late")).toBe(false);
  });

  test("says so when a sub-agent finishes with a message it never picked up", async () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Solver", 12, steerable());
    store.sendSubagentMessage(id, "use backtracking");
    store.collapseEphemeral(id, { durationMs: 5 });
    await Promise.resolve();

    const warnings = store
      .getOutputSnapshot()
      .entries.filter((entry) => entry.type === "warn")
      .map((entry) => String(entry.message));
    expect(warnings).toEqual([
      "Your message to Solver was not delivered: it finished before its next step.",
    ]);
  });

  test("marks every open sub-agent interrupted when the run is aborted", () => {
    const store = new UIStore();
    store.openEphemeral("subagent", "Haiku", 12, steerable());
    store.openEphemeral("subagent", "Opus", 12, steerable());
    store.collapseAllEphemeral();
    expect(store.getSubagentsSnapshot().runs.map((run) => run.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
  });

  test("starts the list over when a new turn begins, keeping any still running", () => {
    const store = new UIStore();
    const finished = store.openEphemeral("subagent", "Done", 12, steerable());
    store.collapseEphemeral(finished, { durationMs: 5 });
    const running = store.openEphemeral("subagent", "Still going", 12, steerable());

    store.setChatBusy(false);
    expect(store.getSubagentsSnapshot().runs).toHaveLength(2);
    store.setChatBusy(true);
    expect(store.getSubagentsSnapshot().runs.map((run) => run.id)).toEqual([running]);
  });

  test("records tool calls from the renderer against the right run", () => {
    const store = new UIStore();
    const id = store.openEphemeral("subagent", "Solver", 12, steerable());
    store.recordSubagentToolStart(id, { toolCallId: "call-1", name: "Read", args: "a.txt" });
    store.recordSubagentToolEnd(id, "call-1", { failed: false, summary: "ok", durationMs: 4 });
    expect(store.getSubagentsSnapshot().runs[0]?.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "call-1",
        name: "Read",
        args: "a.txt",
        status: "ok",
        summary: "ok",
        durationMs: 4,
      },
    ]);
  });
});

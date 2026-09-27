import { describe, expect, it } from "bun:test";
import { stoppedToolCallResult, ToolBatchLedger } from "./tool-batch-ledger";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: `${id}_tool`, arguments: "{}" },
});

describe("ToolBatchLedger", () => {
  it("tells completed, interrupted and never-started calls apart", () => {
    const ledger = new ToolBatchLedger([call("done"), call("running"), call("waiting")]);
    ledger.markStarted("running");
    ledger.markFinished({ toolCallId: "done", name: "done_tool", result: "ok", success: true });

    expect(ledger.report().map((entry) => entry.status)).toEqual([
      "completed",
      "interrupted",
      "not-started",
    ]);
    expect(ledger.outcomeOf("done")?.result).toBe("ok");
  });

  it("tells the model a never-started call changed nothing, and an interrupted one may have", () => {
    expect(stoppedToolCallResult("not-started", "stopped by the user")).toContain(
      "changed nothing",
    );
    expect(stoppedToolCallResult("interrupted", "stopped by the user")).toContain(
      "check the current state",
    );
  });
});

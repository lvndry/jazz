import { describe, expect, it } from "bun:test";
import { interruptSummary, interruptSummaryLines, type ReceiptFacts } from "./interrupt";
import { transcriptRows } from "../fullscreen/Transcript";

const TURN: readonly ReceiptFacts[] = [
  { app: "read_file", summary: "venue.md 40 lines", status: "ok" },
  { app: "mcp_calendar_create_event", args: "Sat 18:00", summary: "hold placed", status: "ok" },
];

describe("interruptSummary", () => {
  it("lists only this turn's calls that changed something, and what never finished", () => {
    const summary = interruptSummary({
      elapsedMs: 6_200,
      receipts: TURN,
      runningTools: [{ app: "web", operation: "search venues" }],
      pendingApproval: "Send email",
      todos: [
        { content: "place a hold", status: "completed" },
        { content: "reply to Dana", status: "pending" },
      ],
    });
    expect(summary.done).toEqual(["mcp_calendar_create_event  Sat 18:00  hold placed"]);
    expect(summary.notDone).toEqual([
      "web  search venues was stopped",
      "Send email was not approved",
      "reply to Dana",
    ]);
  });

  it("says nothing changed rather than leaving the list empty", () => {
    const summary = interruptSummary({
      elapsedMs: 1_000,
      receipts: TURN.slice(0, 1),
      runningTools: [],
      todos: [],
    });
    expect(summary.done).toEqual(["nothing was changed"]);
    expect(summary.notDone).toEqual([]);
  });

  it("caps each list and counts what it hides", () => {
    const summary = interruptSummary({
      elapsedMs: 1_000,
      receipts: [],
      runningTools: [],
      todos: ["a", "b", "c", "d", "e"].map((content) => ({ content, status: "pending" as const })),
    });
    expect(summary.notDone).toEqual(["a", "b", "+3 more"]);
  });
});

describe("the stopped block", () => {
  it("draws a quiet rule with the time, then done and not done rows", () => {
    const rows = transcriptRows(
      [
        {
          id: "s",
          seq: 0,
          kind: "stopped",
          elapsedMs: 6_200,
          done: ["calendar hold placed"],
          notDone: ["reply to Dana"],
        },
      ],
      { width: 120, height: 30 },
    );
    const text = rows.map((row) => row.content.map((segment) => segment.text).join(""));
    expect(text[0]).toContain("stopped by you after 6.2s");
    expect(text[1]).toMatch(/^done\s+calendar hold placed/);
    expect(text[2]).toMatch(/^not done\s+reply to Dana/);
  });
});

describe("interruptSummaryLines", () => {
  it("prints the same words the fullscreen block draws", () => {
    expect(
      interruptSummaryLines({ elapsedMs: 0, done: ["hold placed"], notDone: ["reply"] }, "6.2s"),
    ).toEqual(["stopped by you after 6.2s", "done      hold placed", "not done  reply"]);
  });
});

import { describe, expect, it } from "bun:test";
import {
  describeWhen,
  formatBatches,
  formatReminders,
  formatTriggers,
  type PendingBatch,
} from "./pending";

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

describe("describeWhen", () => {
  it("says how far off an item is, and flags one already due", () => {
    expect(describeWhen(NOW + (2 * 60 + 5) * 60_000, NOW)).toContain("(in 2h 5m)");
    expect(describeWhen(NOW + 3 * 24 * 3_600_000, NOW)).toContain("(in 3d 0h)");
    expect(describeWhen(NOW - 10 * 60_000, NOW)).toContain("(10m ago, due)");
  });
});

describe("listing pending work", () => {
  it("names each reminder's id, agent and text", () => {
    const text = formatReminders(
      [
        {
          agentId: "a1",
          agentName: "assistant",
          id: "r1",
          fireAt: new Date(NOW + 60_000).toISOString(),
          text: "call the dentist",
        },
      ],
      NOW,
    );
    expect(text).toContain("r1");
    expect(text).toContain("[assistant]");
    expect(text).toContain("call the dentist");
  });

  it("shows a trigger's reason, falling back to its prompt", () => {
    const base = {
      agentId: "a1",
      agentName: "assistant",
      id: "t1",
      fireAt: new Date(NOW + 60_000).toISOString(),
      conversationId: "c1",
      prompt: "check the build",
    };
    expect(formatTriggers([{ ...base, reason: "" }], NOW)).toContain("check the build");
    expect(formatTriggers([{ ...base, reason: "waiting on CI" }], NOW)).toContain("waiting on CI");
  });

  it("summarizes a batch's jobs by status", () => {
    const batch: PendingBatch = {
      agentId: "a1",
      agentName: "assistant",
      id: "b1",
      reason: "resize photos",
      createdAt: new Date(NOW).toISOString(),
      completedAt: null,
      jobs: { succeeded: 2, running: 1 },
    };
    const text = formatBatches([batch]);
    expect(text).toContain("b1  active");
    expect(text).toContain("2 succeeded, 1 running");
  });

  it("says so when nothing is waiting", () => {
    expect(formatReminders([], NOW)).toBe("No reminders are waiting.");
    expect(formatTriggers([], NOW)).toBe("No wake triggers are waiting.");
    expect(formatBatches([])).toBe("No job batches are active.");
  });
});

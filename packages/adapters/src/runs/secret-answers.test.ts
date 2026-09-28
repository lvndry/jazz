/** Regression tests for refusing ordinary answers to parked secret requests and naming the secure answer command. */
import { answerHint, parkedRunWaitingItem } from "@jazz/core/daemon/attention";
import { describe, expect, it } from "bun:test";
import { runAnswerOutcome } from "./resume-owned-run";

const pendingSecret = {
  kind: "secret" as const,
  toolCallId: "call_1",
  request: { prompt: "Password for a.pdf", name: "pdf-password" },
};

describe("a run parked on a secret", () => {
  it("is never answered with a chat or command-line answer", () => {
    const outcome = runAnswerOutcome(
      { kind: "secret", runId: "run-1", described: "Password for a.pdf" },
      { kind: "answer", response: "hunter2" },
    );
    expect(outcome.kind).toBe("mismatch");
    if (outcome.kind === "mismatch") {
      expect(outcome.reason).toContain("jazz runs secret run-1");
    }
  });

  it("is announced as waiting for a secret, answered from a terminal", () => {
    const item = parkedRunWaitingItem({
      runId: "run-1",
      agentId: "agent",
      pending: pendingSecret,
      since: "2026-09-28T00:00:00Z",
      who: "A run",
    });
    expect(item).toMatchObject({
      kind: "secret",
      title: "A run needs a secret you type",
      detail: "Password for a.pdf",
    });
    expect(answerHint(item)).toBe("jazz runs secret run-1 (in a terminal)");
  });
});

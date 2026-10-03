import { describe, expect, test } from "bun:test";
import { opensWaitView, waitBlocks, waitRowHints } from "./wait-view";
import type { BackgroundItem } from "../models/background-work";

const WATCH: BackgroundItem = {
  batchId: "batch-1",
  kind: "watch",
  description: "CI run",
  command: "gh run view 1",
  startedAt: 0,
  intervalMs: 30_000,
  expiresAt: 600_000,
  progress: "",
};

describe("wait view", () => {
  test("heads the view with the wait and how long it has left, then its report", () => {
    const [heading, body] = waitBlocks(WATCH, 60_000);

    const label = heading?.kind === "divider" ? heading.label : "";
    expect(label).toContain("CI run");
    expect(label).toContain("gives up in 9m 00s");
    expect(body?.kind).toBe("report");
  });
});

/** The waits list also holds queued jobs, which have no checks to open. */
describe("wait rows", () => {
  const job: BackgroundItem = {
    batchId: "batch-2",
    kind: "job",
    description: "Build",
    command: "make",
    startedAt: 0,
    progress: "",
  };

  test("open the view for a wait, not for a queued job", () => {
    expect(opensWaitView(WATCH)).toBe(true);
    expect(opensWaitView(job)).toBe(false);
    expect(opensWaitView(undefined)).toBe(false);
  });

  test("offer Enter only on a wait", () => {
    expect(waitRowHints(WATCH)).toContain("enter to open");
    expect(waitRowHints(job)).not.toContain("enter to open");
    expect(waitRowHints(job)).toContain("x to cancel");
  });
});

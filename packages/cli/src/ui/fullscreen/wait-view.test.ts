import { describe, expect, test } from "bun:test";
import { waitBlocks } from "./wait-view";
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

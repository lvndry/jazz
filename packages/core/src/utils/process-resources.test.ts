import { describe, expect, it } from "bun:test";
import { sampleProcessResources } from "./process-resources";

describe("sampleProcessResources", () => {
  it("reports Jazz process RSS, heap, and cumulative CPU", () => {
    const snapshot = sampleProcessResources();

    expect(snapshot.rssBytes).toBeGreaterThan(0);
    expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.heapTotalBytes).toBeGreaterThan(0);
    expect(snapshot.externalBytes).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuUserMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuSystemMs).toBeGreaterThanOrEqual(0);
  });
});

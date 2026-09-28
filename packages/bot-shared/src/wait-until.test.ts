import { describe, expect, it } from "bun:test";
import { waitUntil } from "./wait-until";

describe("waitUntil", () => {
  it("resolves once the condition holds", async () => {
    const readyAt = Date.now() + 20;
    await waitUntil(() => Date.now() >= readyAt);
    expect(Date.now()).toBeGreaterThanOrEqual(readyAt);
  });

  it("gives up after the time limit, not after a count of polls", async () => {
    const startedAt = Date.now();
    await expect(waitUntil(() => false, 50)).rejects.toThrow("within 50ms");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});

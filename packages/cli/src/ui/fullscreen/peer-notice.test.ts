import type { LedgerEntry } from "@jazz/core/interfaces/peers";
import { describe, expect, it } from "bun:test";
import { computePeerNotice } from "./peer-notice";

function entry(overrides: Partial<LedgerEntry> & { readonly at: string }): LedgerEntry {
  return {
    direction: "in",
    peer: "sam",
    question: "what's on the calendar?",
    outcome: "answered",
    ...overrides,
  };
}

describe("computePeerNotice", () => {
  it("has nothing to say about an empty ledger", () => {
    expect(computePeerNotice([], undefined)).toEqual({
      notice: undefined,
      newestInboundAt: undefined,
    });
  });

  it("ignores outbound entries — the operator's own ask_peer calls are not news to them", () => {
    const entries = [entry({ at: "2026-08-31T10:00:00Z", direction: "out" })];
    expect(computePeerNotice(entries, undefined)).toEqual({
      notice: undefined,
      newestInboundAt: undefined,
    });
  });

  it("notices a single unseen inbound entry, naming the peer", () => {
    const entries = [entry({ at: "2026-08-31T10:00:00Z", peer: "sam" })];
    const result = computePeerNotice(entries, undefined);
    expect(result.notice).toContain("sam");
    expect(result.newestInboundAt).toBe("2026-08-31T10:00:00Z");
  });

  it("reports a count when several unseen entries share one peer", () => {
    const entries = [
      entry({ at: "2026-08-31T10:02:00Z", peer: "sam" }),
      entry({ at: "2026-08-31T10:01:00Z", peer: "sam" }),
    ];
    const result = computePeerNotice(entries, undefined);
    expect(result.notice).toContain("2");
    expect(result.notice).toContain("sam");
  });

  it("reports a plain count across distinct peers", () => {
    const entries = [
      entry({ at: "2026-08-31T10:02:00Z", peer: "sam" }),
      entry({ at: "2026-08-31T10:01:00Z", peer: "bob" }),
    ];
    const result = computePeerNotice(entries, undefined);
    expect(result.notice).toContain("2");
    expect(result.notice).not.toContain("sam");
    expect(result.notice).not.toContain("bob");
  });

  it("says nothing once every inbound entry is already at or before the cursor", () => {
    const entries = [entry({ at: "2026-08-31T10:00:00Z" })];
    const result = computePeerNotice(entries, "2026-08-31T10:00:00Z");
    expect(result.notice).toBeUndefined();
    // Still reports the newest inbound `at`, so a caller can persist a cursor even on a poll
    // that finds nothing new — the cursor and "is there a notice" are independent questions.
    expect(result.newestInboundAt).toBe("2026-08-31T10:00:00Z");
  });

  it("only surfaces entries strictly newer than the cursor, not the cursor entry itself", () => {
    const entries = [
      entry({ at: "2026-08-31T10:01:00Z", peer: "sam" }),
      entry({ at: "2026-08-31T10:00:00Z", peer: "bob" }),
    ];
    const result = computePeerNotice(entries, "2026-08-31T10:00:00Z");
    expect(result.notice).toContain("sam");
    expect(result.notice).not.toContain("bob");
  });
});

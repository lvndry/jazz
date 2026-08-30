import { describe, expect, it } from "bun:test";
import { inviteStatus, isInviteId, type PeerInviteRecord } from "./peer-invite";

function record(overrides: Partial<PeerInviteRecord> = {}): PeerInviteRecord {
  return {
    id: "0".repeat(32),
    inviteeName: "bob",
    inviterDisplayName: "alice",
    inviterAskUrl: "http://127.0.0.1:4747/peer/ask",
    proposedTier: "about-me",
    createdAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    secretHash: "deadbeef",
    ...overrides,
  };
}

const NOW = new Date("2026-08-30T12:00:00.000Z");

describe("isInviteId", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isInviteId("a".repeat(32))).toBe(true);
    expect(isInviteId("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects anything that did not come from randomBytes(16)", () => {
    expect(isInviteId("")).toBe(false);
    expect(isInviteId("a".repeat(31))).toBe(false);
    expect(isInviteId("A".repeat(32))).toBe(false); // uppercase — not what hex(16) produces
    expect(isInviteId("../../etc/passwd")).toBe(false);
    expect(isInviteId(`${"a".repeat(32)}.json`)).toBe(false);
  });
});

describe("inviteStatus", () => {
  it("is active before expiry, unredeemed, unrevoked", () => {
    expect(inviteStatus(record(), NOW)).toEqual("active");
  });

  it("is expired once past expiresAt", () => {
    expect(inviteStatus(record({ expiresAt: "2026-08-30T00:00:00.000Z" }), NOW)).toEqual("expired");
  });

  it("is redeemed once redeemedAt is set, even if also past expiry", () => {
    expect(
      inviteStatus(
        record({ expiresAt: "2026-08-30T00:00:00.000Z", redeemedAt: "2026-08-30T00:00:01.000Z" }),
        NOW,
      ),
    ).toEqual("redeemed");
  });

  it("is revoked even if it was also redeemed — revocation is checked first", () => {
    expect(
      inviteStatus(
        record({ redeemedAt: "2026-08-30T00:00:01.000Z", revokedAt: "2026-08-30T00:00:02.000Z" }),
        NOW,
      ),
    ).toEqual("revoked");
  });
});

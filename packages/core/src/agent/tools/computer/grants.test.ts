import { statSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  activeGrants,
  type ComputerGrant,
  computerDirectory,
  DEFAULT_GRANT_IDLE_TIMEOUT_MS,
  EMPTY_COMPUTER_STATE,
  grantsFilePath,
  isGrantActive,
  readComputerState,
  shortestIdleTimeoutMs,
  updateComputerState,
  withAcknowledgement,
  withGrant,
  withoutGrant,
} from "./grants";
import { useTemporaryJazzHome } from "./test-home";

const HOUR = 60 * 60 * 1000;

function grant(bundleId: string, overrides: Partial<ComputerGrant> = {}): ComputerGrant {
  return {
    bundleId,
    grantedAt: 1_000,
    expiresAt: 1_000 + 8 * HOUR,
    idleTimeoutMs: 30 * 60 * 1000,
    foreground: false,
    ...overrides,
  };
}

describe("grant expiry", () => {
  test("a grant covers nothing once its expiry has passed", () => {
    const item = grant("com.apple.mail", { expiresAt: 5_000 });
    expect(isGrantActive(item, 4_999)).toBe(true);
    expect(isGrantActive(item, 5_000)).toBe(false);
    expect(activeGrants(withGrant(EMPTY_COMPUTER_STATE, item), 6_000)).toEqual([]);
  });
});

describe("grant changes", () => {
  test("granting an app again replaces its earlier grant", () => {
    const first = grant("com.apple.mail", { expiresAt: 10 });
    const second = grant("com.apple.mail", { expiresAt: 20 });
    const state = withGrant(withGrant(EMPTY_COMPUTER_STATE, first), second);
    expect(state.grants).toEqual([second]);
  });

  test("revoking removes only that app", () => {
    const state = withGrant(withGrant(EMPTY_COMPUTER_STATE, grant("a.b")), grant("c.d"));
    expect(withoutGrant(state, "a.b").grants.map((item) => item.bundleId)).toEqual(["c.d"]);
  });

  test("the shortest idle timeout among the grants bounds the run", () => {
    expect(shortestIdleTimeoutMs([])).toBe(DEFAULT_GRANT_IDLE_TIMEOUT_MS);
    expect(
      shortestIdleTimeoutMs([
        grant("a.b", { idleTimeoutMs: 600_000 }),
        grant("c.d", { idleTimeoutMs: 60_000 }),
      ]),
    ).toBe(60_000);
    expect(shortestIdleTimeoutMs([grant("a.b", { idleTimeoutMs: 4 * HOUR })])).toBe(4 * HOUR);
  });
});

describe("the stored state", () => {
  useTemporaryJazzHome();

  test("reads as nothing acknowledged and nothing granted when there is no file", async () => {
    expect(await readComputerState()).toEqual(EMPTY_COMPUTER_STATE);
  });

  test("round-trips grants and the acknowledgement, in an owner-only file", async () => {
    const acknowledgement = {
      acknowledgedAt: 5,
      driverPath: "/usr/local/bin/cua-driver",
      driverSha256: "a".repeat(64),
    };
    await updateComputerState((state) =>
      withAcknowledgement(withGrant(state, grant("com.apple.mail")), acknowledgement),
    );

    const stored = await readComputerState();
    expect(stored.acknowledgement).toEqual(acknowledgement);
    expect(stored.grants.map((item) => item.bundleId)).toEqual(["com.apple.mail"]);
    expect(statSync(grantsFilePath()).mode & 0o077).toBe(0);
    expect(statSync(computerDirectory()).mode & 0o077).toBe(0);
  });

  test("reads a corrupt file as empty instead of failing", async () => {
    await updateComputerState((state) => withGrant(state, grant("com.apple.mail")));
    await Bun.write(grantsFilePath(), "{ not json");
    expect(await readComputerState()).toEqual(EMPTY_COMPUTER_STATE);
  });

  test("reads a file with unknown fields as empty, so a hand edit cannot smuggle one in", async () => {
    await Bun.write(
      grantsFilePath(),
      JSON.stringify({ version: 1, grants: [{ ...grant("a.b"), tier: "full" }] }),
    );
    expect(await readComputerState()).toEqual(EMPTY_COMPUTER_STATE);
  });

  test("keeps both changes when two are made at once", async () => {
    await Promise.all([
      updateComputerState((state) => withGrant(state, grant("a.b"))),
      updateComputerState((state) => withGrant(state, grant("c.d"))),
    ]);
    const bundleIds = (await readComputerState()).grants.map((item) => item.bundleId).sort();
    expect(bundleIds).toEqual(["a.b", "c.d"]);
  });
});

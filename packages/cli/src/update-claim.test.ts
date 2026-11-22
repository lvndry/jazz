import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  releaseUpdateInstallClaim,
  tryClaimUpdateInstall,
  UPDATE_CLAIM_TTL_MS,
} from "./update-claim";

describe("update install claim", () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-update-claim-"));
  });

  afterEach(() => {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  test("only one of two claimants wins", () => {
    expect(tryClaimUpdateInstall(dataDirectory)).toBe(true);
    expect(tryClaimUpdateInstall(dataDirectory)).toBe(false);
  });

  test("a released claim can be taken again", () => {
    tryClaimUpdateInstall(dataDirectory);
    releaseUpdateInstallClaim(dataDirectory);
    expect(tryClaimUpdateInstall(dataDirectory)).toBe(true);
  });

  test("a claim from a dead installer is taken over after the TTL", () => {
    const start = Date.now();
    expect(tryClaimUpdateInstall(dataDirectory, start)).toBe(true);
    const claimPath = path.join(dataDirectory, "update_install_claim");
    fs.utimesSync(claimPath, start / 1000, start / 1000);

    expect(tryClaimUpdateInstall(dataDirectory, start + UPDATE_CLAIM_TTL_MS - 1000)).toBe(false);
    expect(tryClaimUpdateInstall(dataDirectory, start + UPDATE_CLAIM_TTL_MS + 1000)).toBe(true);
  });

  test("a missing data directory yields no claim", () => {
    expect(tryClaimUpdateInstall(path.join(dataDirectory, "absent"))).toBe(false);
  });
});

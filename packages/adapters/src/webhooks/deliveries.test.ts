import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { claimDelivery, MAX_REMEMBERED_DELIVERIES } from "./deliveries";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "jazz-deliveries-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function claim(webhookName: string, keys: readonly string[]) {
  return Effect.runPromise(
    claimDelivery(webhookName, keys, directory).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

describe("claiming a webhook delivery", () => {
  it("runs a delivery once and refuses it after", async () => {
    expect(await claim("gh", ["delivery:1"])).toBe("fresh");
    expect(await claim("gh", ["delivery:1"])).toBe("duplicate");
  });

  it("refuses a replay under a new delivery id when its signature was seen", async () => {
    expect(await claim("gh", ["delivery:1", "signature:sha256=aa"])).toBe("fresh");
    expect(await claim("gh", ["delivery:2", "signature:sha256=aa"])).toBe("duplicate");
  });

  it("claims nothing for a duplicate, so its other keys stay free", async () => {
    await claim("gh", ["delivery:1"]);
    expect(await claim("gh", ["delivery:1", "signature:sha256=bb"])).toBe("duplicate");
    expect(await claim("gh", ["delivery:3", "signature:sha256=bb"])).toBe("fresh");
  });

  it("keeps each webhook's deliveries apart", async () => {
    await claim("gh", ["delivery:1"]);
    expect(await claim("stripe", ["delivery:1"])).toBe("fresh");
  });

  it("lets a request with no delivery keys through", async () => {
    expect(await claim("gh", [])).toBe("fresh");
    expect(await claim("gh", [])).toBe("fresh");
  });

  it("survives a restart, since the record is on disk", async () => {
    await claim("gh", ["delivery:1"]);
    const record = JSON.parse(await readFile(path.join(directory, "gh.json"), "utf8"));
    expect(record).toEqual(["delivery:1"]);
  });

  it("remembers only the most recent deliveries", async () => {
    for (let index = 0; index <= MAX_REMEMBERED_DELIVERIES; index++) {
      await claim("gh", [`delivery:${String(index)}`]);
    }
    expect(await claim("gh", ["delivery:0"])).toBe("fresh");
    expect(await claim("gh", [`delivery:${String(MAX_REMEMBERED_DELIVERIES)}`])).toBe("duplicate");
  });

  it("lets only one of two concurrent copies through", async () => {
    const outcomes = await Promise.all([claim("gh", ["delivery:9"]), claim("gh", ["delivery:9"])]);
    expect(outcomes.sort()).toEqual(["duplicate", "fresh"]);
  });
});

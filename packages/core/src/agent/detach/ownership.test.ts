import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  abortDetach,
  assertConversationWritable,
  commitDetach,
  prepareDetach,
  releaseDetach,
} from "./ownership";

let directory: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env["JAZZ_HOME"];
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-detach-owner-"));
  process.env["JAZZ_HOME"] = directory;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousHome;
  }
  await fs.rm(directory, { recursive: true, force: true });
});

describe("conversation ownership", () => {
  const handoff = {
    agentId: "agent",
    conversationId: "conversation",
    handoffId: "handoff",
    targetHost: "server",
  };

  test("preparation fences new local work and abort restores it", async () => {
    await prepareDetach(handoff);
    await expect(assertConversationWritable("agent", "conversation")).rejects.toThrow("preparing");
    await abortDetach(handoff);
    await expect(assertConversationWritable("agent", "conversation")).resolves.toBeUndefined();
  });

  test("committed ownership cannot be aborted or replaced", async () => {
    await prepareDetach(handoff);
    await commitDetach(handoff);
    await expect(assertConversationWritable("agent", "conversation")).rejects.toThrow("remote");
    await expect(abortDetach(handoff)).rejects.toThrow("cannot be aborted");
    await expect(prepareDetach({ ...handoff, handoffId: "other" })).rejects.toThrow("already");
  });

  test("same handoff is idempotent", async () => {
    await prepareDetach(handoff);
    await prepareDetach(handoff);
    await commitDetach(handoff);
    await commitDetach(handoff);
  });

  test("rejects path-shaped identifiers", async () => {
    await expect(prepareDetach({ ...handoff, conversationId: "../other" })).rejects.toThrow(
      "Invalid",
    );
  });

  test("reclaim lifts only a committed fence, and only for its own handoff", async () => {
    await prepareDetach(handoff);
    await expect(releaseDetach(handoff)).rejects.toThrow("committed");
    await commitDetach(handoff);
    await expect(releaseDetach({ ...handoff, handoffId: "other" })).rejects.toThrow("does not own");
    await releaseDetach(handoff);
    await expect(assertConversationWritable("agent", "conversation")).resolves.toBeUndefined();
    await expect(releaseDetach(handoff)).resolves.toBeUndefined();
  });

  test("the handoff that holds the fence may still write through it", async () => {
    await prepareDetach(handoff);
    await commitDetach(handoff);
    await expect(
      assertConversationWritable("agent", "conversation", "handoff"),
    ).resolves.toBeUndefined();
    await expect(assertConversationWritable("agent", "conversation", "other")).rejects.toThrow(
      "remote",
    );
  });
});

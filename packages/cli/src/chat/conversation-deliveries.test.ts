import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { claimDueJobs, completeJob, JobQueueServiceImpl } from "@jazz/adapters/job-queue-service";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  awaitOwedDelivery,
  chatDeliveryOutcome,
  claimOwedDelivery,
} from "./conversation-deliveries";

let jazzHome: string;
const originalJazzHome = process.env["JAZZ_HOME"];

beforeEach(() => {
  jazzHome = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-conversation-deliveries-test-"));
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(() => {
  fs.rmSync(jazzHome, { recursive: true, force: true });
  if (originalJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = originalJazzHome;
  }
});

function run<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<A, E, never>,
  );
}

async function finishedWait(conversationId: string): Promise<string> {
  const batchDirectory = path.join(jazzHome, "job-batches");
  const service = new JobQueueServiceImpl({ baseJobBatchDirectory: batchDirectory });
  const outcome = await run(
    service.enqueueBatch(
      "agent-1",
      conversationId,
      [{ command: "true", poll: { intervalMs: 1_000, timeoutMs: 60_000 } }],
      { workingDir: "/tmp", reason: "review run finished" },
    ),
  );
  if (!outcome.success) throw new Error("enqueue failed");
  const [claimed] = await run(claimDueJobs(batchDirectory, "agent-1", Date.now(), 1, "worker"));
  if (claimed === undefined) throw new Error("nothing claimed");
  await run(
    completeJob(batchDirectory, "agent-1", claimed.batchId, claimed.jobId, {
      success: true,
      result: { stdout: "review run: completed", stderr: "", exitCode: 0 },
      error: null,
    }),
  );
  return claimed.batchId;
}

describe("conversation deliveries", () => {
  test("a finished wait on the open conversation becomes the chat's turn, once", async () => {
    const batchId = await finishedWait("conv-1");
    await run(awaitOwedDelivery("agent-1", "conv-1", 10, { waitFirst: false }));

    const delivery = await run(claimOwedDelivery("agent-1", "conv-1"));
    expect(delivery?.announcement).toContain("review run finished");
    expect(delivery?.prompt).toContain("review run: completed");
    expect(delivery?.origin).toEqual({ source: "job", name: batchId });
    expect(await run(claimOwedDelivery("agent-1", "conv-1"))).toBeUndefined();

    await run(delivery!.settle({ delivered: true }));
    expect(
      fs.existsSync(path.join(jazzHome, "job-batches", ".archive", "agent-1", `${batchId}.json`)),
    ).toBe(true);
  });

  test("another conversation's finished wait is not this chat's", async () => {
    await finishedWait("conv-2");
    expect(await run(claimOwedDelivery("agent-1", "conv-1"))).toBeUndefined();
    const watched = await run(
      awaitOwedDelivery("agent-1", "conv-1", 10, { waitFirst: false }).pipe(
        Effect.timeout("100 millis"),
        Effect.option,
      ),
    );
    expect(watched._tag).toBe("None");
  });

  test("a delivery turn that failed before keeping any work is retried; any other is delivered", () => {
    expect(chatDeliveryOutcome({ errored: true, keptWork: false })).toMatchObject({
      delivered: false,
      retryable: true,
    });
    expect(chatDeliveryOutcome({ errored: true, keptWork: true })).toEqual({ delivered: true });
    expect(chatDeliveryOutcome({ errored: false, keptWork: false })).toEqual({ delivered: true });
  });
});

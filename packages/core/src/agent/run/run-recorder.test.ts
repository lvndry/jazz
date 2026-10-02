import { InMemoryRunStore } from "@jazz/adapters/storage/run-store";
import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { OccupancyServiceTag, type OccupancyService } from "@/core/interfaces/occupancy";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { GenerationInterruptedError } from "@/core/types/errors";
import type { OccupancyEntry } from "@/core/types/occupancy";
import { ToolActivityTracker } from "./tool-activity";
import type { AgentResponse } from "../types";
import { RunParkRequested } from "./park-signal";
import { withRunRecording, type RunRecordingInput } from "./run-recorder";

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const INPUT = {
  runId: RUN_ID,
  agentId: "assistant",
  conversationId: "conv-1",
  userInput: "push the branch",
  internal: false,
};

function response(content: string): AgentResponse {
  return { content, conversationId: "conv-1" };
}

const PARK = new RunParkRequested({
  pending: {
    kind: "tool-approval",
    request: {
      toolCallId: "call_7",
      toolName: "execute_command",
      message: "Run `git push`",
      executeToolName: "execute_command_execute",
      executeArgs: { command: "git push" },
    },
  },
  messages: [{ role: "user", content: "push the branch" }],
  iteration: 2,
});

async function runWith<E>(
  store: InMemoryRunStore | undefined,
  effect: Effect.Effect<AgentResponse, E>,
  input: RunRecordingInput = INPUT,
) {
  const layer = store === undefined ? Layer.empty : Layer.succeed(RunStoreTag, store);
  return Effect.runPromiseExit(
    withRunRecording(input, effect).pipe(Effect.provide(layer)) as Effect.Effect<
      AgentResponse,
      unknown
    >,
  );
}

describe("withRunRecording", () => {
  it("keeps the authority and iteration cap a run started with, for its resume", async () => {
    const store = new InMemoryRunStore();
    await runWith(store, Effect.fail(PARK), {
      ...INPUT,
      approvalPolicy: "read-only",
      autoApprovedTools: ["git_status"],
      maxIterations: 24,
    });
    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record).toMatchObject({
      approvalPolicy: "read-only",
      autoApprovedTools: ["git_status"],
      maxIterations: 24,
    });
  });

  it("records a completed run", async () => {
    const store = new InMemoryRunStore();
    const exit = await runWith(store, Effect.succeed(response("pushed")));

    expect(exit._tag).toBe("Success");
    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record?.state).toMatchObject({ kind: "completed", content: "pushed" });
  });

  it("records a failed run and still propagates the failure", async () => {
    const store = new InMemoryRunStore();
    const exit = await runWith(store, Effect.fail(new Error("provider exploded")));

    expect(exit._tag).toBe("Failure");
    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record?.state).toMatchObject({ kind: "failed", cause: "error" });
  });

  it("reads a timeout as its own failure cause", async () => {
    const store = new InMemoryRunStore();
    await runWith(store, Effect.fail(new Error("Run exceeded the 300000ms timeout.")));

    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record?.state).toMatchObject({ kind: "failed", cause: "timeout" });
  });

  it("records an interrupted run as canceled, not failed", async () => {
    const store = new InMemoryRunStore();
    await runWith(
      store,
      Effect.fail(new GenerationInterruptedError({ reason: "user pressed escape twice" })),
    );

    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record?.state).toMatchObject({ kind: "canceled", at: "working" });
  });

  it("parks with everything a later process needs to resume", async () => {
    const store = new InMemoryRunStore();
    const exit = await runWith(store, Effect.fail(PARK));

    expect(exit._tag).toBe("Failure");
    const record = await Effect.runPromise(store.get(RUN_ID));
    if (record?.state.kind !== "input-required") throw new Error("expected a parked run");

    expect(record.state.pending.kind).toBe("tool-approval");
    if (record.state.pending.kind !== "tool-approval") throw new Error("expected an approval");
    expect(record.state.pending.request.toolCallId).toBe("call_7");
    expect(record.state.snapshot.messages).toHaveLength(1);
    expect(record.state.snapshot.iteration).toBe(2);
    expect(new Date(record.state.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not record sub-agent runs", async () => {
    const store = new InMemoryRunStore();
    await runWith(store, Effect.succeed(response("summary")), { ...INPUT, internal: true });

    expect(await Effect.runPromise(store.get(RUN_ID))).toBeUndefined();
  });

  it("is a pass-through with no store in the layer", async () => {
    const exit = await runWith(undefined, Effect.succeed(response("fine")));
    expect(exit._tag).toBe("Success");
  });

  it("continues an existing record instead of starting a second one", async () => {
    const store = new InMemoryRunStore();
    await runWith(store, Effect.fail(PARK));
    const parked = await Effect.runPromise(store.get(RUN_ID));
    const parkedAt = parked?.createdAt;

    // What `resumeRun` does before handing back to the runner.
    await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 2 }));
    const exit = await runWith(store, Effect.succeed(response("pushed")));

    expect(exit._tag).toBe("Success");
    const record = await Effect.runPromise(store.get(RUN_ID));
    expect(record?.state).toMatchObject({ kind: "completed", content: "pushed" });
    expect(record?.createdAt).toBe(parkedAt);
    expect(await Effect.runPromise(store.list())).toHaveLength(0);
  });

  it("keeps cumulative usage across approval resumes without charging parked time", async () => {
    const store = new InMemoryRunStore();
    const firstSegment = {
      ...INPUT,
      totalTokensSoFar: () => 120,
      costSoFarUSD: () => 0.12,
    };
    await runWith(store, Effect.fail(PARK), firstSegment);
    const parked = await Effect.runPromise(store.get(RUN_ID));
    await new Promise((resolve) => setTimeout(resolve, 120));

    await Effect.runPromise(store.transition(RUN_ID, { kind: "working", iteration: 2 }));
    const secondSegment = {
      ...INPUT,
      totalTokensSoFar: () => 80,
      costSoFarUSD: () => 0.08,
    };
    await runWith(store, Effect.succeed(response("done")), secondSegment);
    const completed = await Effect.runPromise(store.get(RUN_ID));

    expect(completed?.totalTokens).toBe(200);
    expect(completed?.costUSD).toBeCloseTo(0.2);
    expect(completed?.activeDurationMs).toBeDefined();
    expect((completed?.activeDurationMs ?? 0) + 60).toBeLessThan(
      Date.now() - Date.parse(parked?.createdAt ?? new Date().toISOString()),
    );
  });
});

function recordOccupancy(): {
  layer: Layer.Layer<OccupancyService, never>;
  entries: OccupancyEntry[];
} {
  const entries: OccupancyEntry[] = [];
  const layer = Layer.succeed(OccupancyServiceTag, {
    record: (entry: OccupancyEntry) =>
      Effect.sync(() => {
        entries.push(entry);
      }),
    list: () => Effect.succeed(entries),
  });
  return { layer, entries };
}

describe("withRunRecording occupancy heartbeat", () => {
  it("writes an entry with the activity record and a final terminal state", async () => {
    const store = new InMemoryRunStore();
    const { layer, entries } = recordOccupancy();
    const tracker = new ToolActivityTracker();
    tracker.record({
      toolName: "write_file",
      riskLevel: "low-risk",
      path: "src/a.ts",
      at: new Date().toISOString(),
    });

    const exit = await Effect.runPromiseExit(
      withRunRecording(
        {
          ...INPUT,
          workingDirectory: "/work/repo",
          agentName: "Assistant",
          toolActivity: tracker,
        },
        Effect.succeed(response("Done")),
      ).pipe(Effect.provide(Layer.merge(Layer.succeed(RunStoreTag, store), layer))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const first = entries[0]!;
    expect(first).toMatchObject({
      runId: RUN_ID,
      workingDirectory: "/work/repo",
      agentName: "Assistant",
      lastMutatingTool: "write_file",
      lastMutatingPath: "src/a.ts",
    });
    expect(first.state).toBe("working");
    expect(entries.at(-1)!.state).toBe("completed");
  });

  it("writes a failed terminal entry when the run fails, and the failure still propagates", async () => {
    const store = new InMemoryRunStore();
    const { layer, entries } = recordOccupancy();
    const exit = await Effect.runPromiseExit(
      withRunRecording(INPUT, Effect.fail(new Error("model said no"))).pipe(
        Effect.provide(Layer.merge(Layer.succeed(RunStoreTag, store), layer)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(entries.at(-1)!.state).toBe("failed");
  });

  it("still completes when the occupancy service fails, best-effort end to end", async () => {
    const store = new InMemoryRunStore();
    // The service's type promises no failures; cast to prove the recorder still swallows
    // one if a future implementation breaks that promise.
    const failing = Layer.succeed(OccupancyServiceTag, {
      record: (() =>
        Effect.fail(new Error("disk said no"))) as unknown as OccupancyService["record"],
      list: (() => Effect.fail(new Error("disk said no"))) as unknown as OccupancyService["list"],
    });
    const result = await Effect.runPromise(
      withRunRecording(INPUT, Effect.succeed(response("ok"))).pipe(
        Effect.provide(Layer.merge(Layer.succeed(RunStoreTag, store), failing)),
      ),
    );
    expect(result).toMatchObject({ content: "ok" });
  });
});

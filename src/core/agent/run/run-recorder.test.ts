import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { GenerationInterruptedError } from "@/core/types/errors";
import { InMemoryRunStore } from "@/services/storage/run-store";
import type { AgentResponse } from "../types";
import { RunParkRequested } from "./park-signal";
import { withRunRecording } from "./run-recorder";

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
  input = INPUT,
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
    expect(await Effect.runPromise(store.listActive())).toHaveLength(0);
  });
});

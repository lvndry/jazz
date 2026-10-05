import { describe, expect, it } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import type { ToolExecutionResult } from "@/core/types/tools";
import { createSubagentSupervisor, type SubagentSupervisor } from "./supervisor";

const done = (text: string): ToolExecutionResult => ({ success: true, result: text });

/** Register a child and let it finish at once with `result`. */
function finishedChild(supervisor: SubagentSupervisor, name: string, result: ToolExecutionResult) {
  return Effect.gen(function* () {
    const hooks = supervisor.register({ name });
    yield* supervisor.start(hooks.id, Effect.succeed(result));
    yield* Effect.yieldNow();
    return hooks;
  });
}

/** A child that finishes when `release` is completed, reporting through its hooks as it goes. */
function startChild(
  supervisor: SubagentSupervisor,
  name: string,
  release: Deferred.Deferred<string>,
) {
  return Effect.gen(function* () {
    const hooks = supervisor.register({ name });
    yield* supervisor.start(
      hooks.id,
      Effect.gen(function* () {
        yield* hooks.beforeStep();
        const text = yield* Deferred.await(release);
        return done(text);
      }),
    );
    return hooks;
  });
}

describe("SubagentSupervisor", () => {
  it("returns every child's result once none is running, and marks them read", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const first = yield* Deferred.make<string>();
        const second = yield* Deferred.make<string>();
        yield* startChild(supervisor, "one", first);
        yield* startChild(supervisor, "two", second);
        expect(supervisor.liveCount()).toBe(2);
        const waiting = yield* Effect.fork(supervisor.wait([], "all", 5_000));
        yield* Deferred.succeed(first, "first done");
        yield* Deferred.succeed(second, "second done");
        const result = yield* Fiber.join(waiting);
        return { result, notices: supervisor.takeNotices(), live: supervisor.liveCount() };
      }),
    );
    expect(outcome.result.timedOut).toBe(false);
    expect(
      outcome.result.subagents.map((child) => [child.name, child.status, child.result]),
    ).toEqual([
      ["one", "completed", "first done"],
      ["two", "completed", "second done"],
    ]);
    expect(outcome.notices).toEqual([]);
    expect(outcome.live).toBe(0);
  });

  it("keeps each answer, lists status only, and returns an answer once", async () => {
    const saved: string[] = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor({
          saveResult: (child) => {
            saved.push(String(child.result));
            return `subagent-${child.id}`;
          },
        });
        const hooks = yield* finishedChild(supervisor, "digest", done("the whole report"));
        const listed = supervisor.list()[0];
        const first = (yield* supervisor.wait([], "all", 5_000)).subagents[0];
        const second = (yield* supervisor.wait([], "all", 5_000)).subagents[0];
        const steered = yield* supervisor.steer(hooks.id, "message", "write it to a file");
        return { id: hooks.id, listed, first, second, steered };
      }),
    );
    const retrieveId = `subagent-${outcome.id}`;
    expect(saved).toEqual(["the whole report"]);
    expect(outcome.listed).toMatchObject({ status: "completed", retrieveId });
    expect(outcome.listed).not.toHaveProperty("result");
    expect(outcome.first).toMatchObject({ result: "the whole report", retrieveId });
    expect(outcome.first).not.toHaveProperty("alreadyRead");
    expect(outcome.second).toMatchObject({ alreadyRead: true, retrieveId });
    expect(outcome.second).not.toHaveProperty("result");
    expect(outcome.steered).toMatchObject({ ok: false });
    expect(outcome.steered.ok ? "" : outcome.steered.error).toContain(
      `retrieve_tool_result with tool_call_id "${retrieveId}"`,
    );
  });

  it("returns on the first child to finish with until any, and times out with none", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const first = yield* Deferred.make<string>();
        const second = yield* Deferred.make<string>();
        yield* startChild(supervisor, "one", first);
        yield* startChild(supervisor, "two", second);
        const timedOut = yield* supervisor.wait([], "any", 20);
        const waiting = yield* Effect.fork(supervisor.wait([], "any", 5_000));
        yield* Deferred.succeed(first, "first done");
        return { timedOut, any: yield* Fiber.join(waiting) };
      }),
    );
    expect(outcome.timedOut.timedOut).toBe(true);
    expect(outcome.any.timedOut).toBe(false);
    expect(outcome.any.subagents.map((child) => child.status)).toEqual(["completed", "running"]);
  });

  it("announces a finished child the parent has not read, once", async () => {
    const notices = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        yield* finishedChild(supervisor, "digest", done("ok"));
        return [supervisor.takeNotices(), supervisor.takeNotices()];
      }),
    );
    expect(notices[0]).toHaveLength(1);
    expect(notices[0]?.[0]).toMatch(
      /^Sub-agent digest \(sa-\d+\) completed; call wait_subagents to read its result\.$/,
    );
    expect(notices[1]).toEqual([]);
  });

  it("queues a parent message for the child's next step", async () => {
    const taken = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = yield* startChild(supervisor, "worker", yield* Deferred.make<string>());
        const steered = yield* supervisor.steer(hooks.id, "message", "focus on the EU prices");
        return { steered, first: hooks.takeParentMessage(), second: hooks.takeParentMessage() };
      }),
    );
    expect(taken.steered.ok).toBe(true);
    expect(taken.first).toBe("focus on the EU prices");
    expect(taken.second).toBeUndefined();
  });

  it("reports parent messages a child finished before reading", async () => {
    const child = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        yield* supervisor.steer(hooks.id, "message", "also add Portugal");
        yield* supervisor.start(hooks.id, Effect.succeed(done("Paris, Madrid, Rome")));
        yield* supervisor.wait([hooks.id], "all", 5_000);
        return supervisor.list()[0];
      }),
    );
    expect(child).toMatchObject({
      status: "completed",
      undeliveredMessages: ["also add Portugal"],
    });
  });

  it("holds a paused child at its step boundary until it is resumed", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        const steps: string[] = [];
        yield* supervisor.steer(hooks.id, "pause");
        const child = yield* Effect.fork(
          Effect.gen(function* () {
            yield* hooks.beforeStep();
            steps.push("step");
          }),
        );
        yield* Effect.yieldNow();
        const whilePaused = { steps: [...steps], status: supervisor.list()[0]?.status };
        yield* supervisor.steer(hooks.id, "resume");
        yield* Fiber.join(child);
        return { whilePaused, after: steps, status: supervisor.list()[0]?.status };
      }),
    );
    expect(outcome.whilePaused).toEqual({ steps: [], status: "paused" });
    expect(outcome.after).toEqual(["step"]);
    expect(outcome.status).toBe("running");
  });

  it("cancels a child at once and says the parent cancelled it", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = yield* startChild(supervisor, "worker", yield* Deferred.make<string>());
        const steered = yield* supervisor.steer(hooks.id, "cancel");
        const again = yield* supervisor.steer(hooks.id, "message", "too late");
        return { steered, again, child: supervisor.list()[0] };
      }),
    );
    expect(outcome.steered).toMatchObject({ ok: true, status: "cancelled" });
    expect(outcome.child).toMatchObject({
      status: "cancelled",
      error: "Cancelled by the parent agent.",
    });
    expect(outcome.again.ok).toBe(false);
  });

  it("names an agentId that does not exist in this run", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        return yield* supervisor.steer("sa-nope", "pause");
      }),
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok ? "" : outcome.error).toContain("sa-nope");
  });

  it("before an answer, cancels paused children, waits for running ones and asks for their results once", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const release = yield* Deferred.make<string>();
        yield* startChild(supervisor, "running", release);
        const paused = supervisor.register({ name: "paused" });
        yield* supervisor.steer(paused.id, "pause");
        yield* supervisor.start(
          paused.id,
          Effect.gen(function* () {
            yield* paused.beforeStep();
            return done("never");
          }),
        );
        yield* Effect.yieldNow();
        const settling = yield* Effect.fork(supervisor.settleBeforeAnswer());
        yield* Deferred.succeed(release, "found it");
        const notice = yield* Fiber.join(settling);
        const second = yield* supervisor.settleBeforeAnswer();
        return { notice, second, children: supervisor.list() };
      }),
    );
    expect(outcome.notice).toContain("running (sa-");
    expect(outcome.notice).toContain("1 paused sub-agent was cancelled");
    expect(outcome.notice).toContain("wait_subagents");
    expect(outcome.second).toBeUndefined();
    expect(outcome.children.map((child) => child.status)).toEqual(["completed", "cancelled"]);
  });

  it("lets the answer stand once every result was read", async () => {
    const notice = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        yield* finishedChild(supervisor, "read", done("x"));
        yield* supervisor.wait([], "all", 5_000);
        return yield* supervisor.settleBeforeAnswer();
      }),
    );
    expect(notice).toBeUndefined();
  });

  it("counts children's live spend against the run's cost cap", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        supervisor.bindCostCap(1, () => 0.4);
        const first = supervisor.register({ name: "one" });
        const second = supervisor.register({ name: "two" });
        first.reportSpend(0.3);
        const underCap = supervisor.costExhausted();
        second.reportSpend(0.35);
        return { underCap, overCap: supervisor.costExhausted(), live: supervisor.liveCostUSD() };
      }),
    );
    expect(outcome.underCap).toBe(false);
    expect(outcome.overCap).toBe(true);
    expect(outcome.live).toBeCloseTo(0.65);
  });

  it("stops every child still going when the run closes it", async () => {
    const children = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        yield* startChild(supervisor, "worker", yield* Deferred.make<string>());
        yield* supervisor.close();
        return supervisor.list();
      }),
    );
    expect(children[0]).toMatchObject({
      status: "cancelled",
      error: "Stopped when the parent run ended.",
    });
  });

  it("marks a child running again once it reports progress past a declined approval", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        hooks.onToolEvent({ kind: "approval-required", toolName: "web_fetch" });
        hooks.reportSpend(0.01);
        return supervisor.list()[0]?.status;
      }),
    );
    expect(status).toBe("running");
  });

  it("keeps waiting while a child waits on a person's approval", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        hooks.onToolEvent({ kind: "approval-required", toolName: "execute_command" });
        return yield* supervisor.wait([], "any", 30);
      }),
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.subagents[0]?.status).toBe("waiting-approval");
  });

  it("says so when asked to resume a child that is not paused", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        return yield* supervisor.steer(hooks.id, "resume");
      }),
    );
    expect(outcome).toMatchObject({ ok: true, note: "It was not paused; nothing changed." });
  });

  it("marks a child waiting on approval, and running again once it moves on", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* createSubagentSupervisor();
        const hooks = supervisor.register({ name: "worker" });
        hooks.onToolEvent({ kind: "approval-required", toolName: "execute_command" });
        const waiting = supervisor.list()[0];
        hooks.onToolEvent({ kind: "tool-started", toolName: "execute_command" });
        return [waiting, supervisor.list()[0]];
      }),
    );
    expect(statuses[0]).toMatchObject({
      status: "waiting-approval",
      lastActivity: "waiting on approval for execute_command",
    });
    expect(statuses[1]).toMatchObject({ status: "running", lastActivity: "execute_command" });
  });
});

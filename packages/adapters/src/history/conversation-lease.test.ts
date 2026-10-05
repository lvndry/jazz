import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { ConversationBusyError, withConversationTurn } from "./conversation-lease";
import { conversationTurnLockPath } from "./conversation-log";

let historyDirectory: string;

beforeEach(() => {
  historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-conversation-lease-test-"));
});

afterEach(() => {
  fs.rmSync(historyDirectory, { recursive: true, force: true });
});

function turn<A>(
  work: Effect.Effect<A>,
  options: { onBusy?: Effect.Effect<void>; maxWaitMs?: number } = {},
) {
  return withConversationTurn("agent-1", "conv-1", work, { historyDirectory, ...options });
}

describe("withConversationTurn", () => {
  test("a second turn on the conversation waits for the first, then runs", async () => {
    const order: string[] = [];
    let busyNotices = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const finishFirst = yield* Deferred.make<void>();
        const first = yield* Effect.fork(
          turn(
            Effect.gen(function* () {
              order.push("first starts");
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(finishFirst);
              order.push("first ends");
            }),
          ),
        );
        yield* Deferred.await(firstStarted);
        const second = yield* Effect.fork(
          turn(
            Effect.sync(() => {
              order.push("second runs");
            }),
            {
              onBusy: Effect.sync(() => {
                busyNotices += 1;
              }),
            },
          ),
        );
        yield* Effect.sleep("1200 millis");
        yield* Deferred.succeed(finishFirst, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
    expect(order).toEqual(["first starts", "first ends", "second runs"]);
    expect(busyNotices).toBe(1);
  });

  test("a turn that would wait longer than it allows gives up", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          turn(Effect.zipRight(Deferred.succeed(started, undefined), Effect.never)),
        );
        yield* Deferred.await(started);
        const result = yield* turn(Effect.void, { maxWaitMs: 100 }).pipe(Effect.exit);
        yield* Fiber.interrupt(holder);
        return yield* result;
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("ConversationBusyError");
    }
  });

  test("interrupting a turn, waiting or running, leaves the conversation free", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          turn(Effect.zipRight(Deferred.succeed(started, undefined), Effect.never)),
        );
        yield* Deferred.await(started);
        const waiter = yield* Effect.fork(turn(Effect.void));
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(waiter);
        yield* Fiber.interrupt(holder);
      }),
    );
    expect(fs.existsSync(conversationTurnLockPath("agent-1", "conv-1", historyDirectory))).toBe(
      false,
    );
    const ran = await Effect.runPromise(turn(Effect.succeed("ran"), { maxWaitMs: 100 }));
    expect(ran).toBe("ran");
  });

  test("a turn held by a process that died is taken over", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    const lockPath = conversationTurnLockPath("agent-1", "conv-1", historyDirectory);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: child.pid, host: os.hostname(), token: "dead" }),
    );
    const ran = await Effect.runPromise(turn(Effect.succeed("ran"), { maxWaitMs: 2_000 }));
    expect(ran).toBe("ran");
  });

  test("turns on different conversations do not wait for each other", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          turn(Effect.zipRight(Deferred.succeed(started, undefined), Effect.never)),
        );
        yield* Deferred.await(started);
        yield* withConversationTurn("agent-1", "conv-2", Effect.void, {
          historyDirectory,
          maxWaitMs: 100,
        });
        yield* Fiber.interrupt(holder);
      }),
    );
  });
});

test("ConversationBusyError names the conversation", () => {
  expect(new ConversationBusyError("conv-1", 2_000).message).toContain("conv-1");
});

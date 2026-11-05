import { DETACHED_RESULT_HEADING } from "@jazz/core/agent/execution/egress-taint";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createDetachedResultInbox,
  detachedResultsMessage,
  detachedResultsNotice,
  pushWhileOpen,
  stoppedDetachedMessage,
} from "./detached-results";

const finished = { toolName: "execute_command", summary: "Background task done: ok" };

describe("detached result inbox", () => {
  test("hands results over oldest first and empties itself", () => {
    const inbox = createDetachedResultInbox();
    inbox.push(finished);
    inbox.push({ ...finished, toolName: "web_fetch" });
    expect(inbox.take().map((result) => result.toolName)).toEqual(["execute_command", "web_fetch"]);
    expect(inbox.take()).toEqual([]);
  });

  test("wakes a waiting listener once, on the first push", () => {
    const inbox = createDetachedResultInbox();
    let wakes = 0;
    inbox.once(() => {
      wakes += 1;
    });
    inbox.push(finished);
    inbox.push(finished);
    expect(wakes).toBe(1);
  });

  test("fires at once when a result is already waiting", () => {
    const inbox = createDetachedResultInbox();
    inbox.push(finished);
    let woke = false;
    inbox.once(() => {
      woke = true;
    });
    expect(woke).toBe(true);
  });

  test("a cancelled listener is never called", () => {
    const inbox = createDetachedResultInbox();
    let woke = false;
    const cancel = inbox.once(() => {
      woke = true;
    });
    cancel();
    inbox.push(finished);
    expect(woke).toBe(false);
  });
});

describe("detached result text", () => {
  test("the agent's message keeps the host heading on every result", () => {
    const message = detachedResultsMessage([finished, finished]);
    expect(message.split(DETACHED_RESULT_HEADING)).toHaveLength(3);
  });

  test("the person sees the called tool names, not the raw result", () => {
    const notice = detachedResultsNotice([finished]);
    expect(notice).toBe("`execute_command` finished in the background.");
    expect(notice).not.toContain("ok");
  });
});

describe("detached results across conversations", () => {
  test("drops a result that arrives after the conversation was left", () => {
    const inbox = createDetachedResultInbox();
    let open = "conversation-a";
    const dropped: string[] = [];
    const push = pushWhileOpen(
      inbox,
      "conversation-a",
      () => open,
      (result) => dropped.push(result.summary),
    );

    push(finished);
    open = "conversation-b";
    push({ ...finished, summary: "stopped before it finished" });

    expect(inbox.take()).toEqual([finished]);
    expect(dropped).toEqual(["stopped before it finished"]);
  });

  test("never wakes a listener of the conversation that was switched to", () => {
    const inbox = createDetachedResultInbox();
    let woke = false;
    inbox.once(() => {
      woke = true;
    });
    pushWhileOpen(
      inbox,
      "old",
      () => "new",
      () => {},
    )(finished);
    expect(woke).toBe(false);
  });

  test("closes a history with one host message per stopped command", () => {
    const message = stoppedDetachedMessage([
      {
        toolCallId: "call-1",
        toolName: "execute_command",
        description: "make all",
        origin: "auto",
        startedAt: 0,
        stop: Effect.void,
      },
    ]);
    expect(message.role).toBe("user");
    expect(message.content).toContain(DETACHED_RESULT_HEADING);
    expect(message.content).toContain("make all");
  });
});

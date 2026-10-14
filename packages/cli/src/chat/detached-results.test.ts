import { DETACHED_RESULT_HEADING } from "@jazz/core/agent/execution/egress-taint";
import { describe, expect, test } from "bun:test";
import {
  createDetachedResultInbox,
  detachedResultsMessage,
  detachedResultsNotice,
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

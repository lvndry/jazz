/** @jsxImportSource @opentui/react */
/**
 * Proves the fullscreen interface is actually wired to the live store, rather
 * than only to the sample fixture. Writes go in through the same store methods
 * the presentation service uses, and the assertions read the rendered frame.
 */

import { testRender } from "@opentui/react/test-utils";
import { beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { store } from "../store";
import { FullscreenBridge } from "./bridge";

/**
 * Settles a state update dispatched from a keyboard event.
 *
 * `flush()` drains microtasks and the renderer's paint-pending flag, but a
 * `setState` called from an external event-emitter callback (which is what a
 * keypress is) is committed by React's scheduler through a macrotask —
 * `setTimeout`/`MessageChannel` — which a microtask-only wait can never see.
 * A bare tick supplies that for an ordinary character, and was confirmed
 * against a minimal useState+useKeyboard repro outside this file before
 * trusting it here.
 *
 * `Escape` needs longer: a lone ESC byte is indistinguishable from the first
 * byte of a multi-byte sequence (every arrow and function key starts with one),
 * so the input parser holds it for a short real window before deciding it was
 * Escape alone — also confirmed against the same repro, where a 0ms tick never
 * saw the key at all and 100ms reliably did.
 */
async function settleKeypress(flush: () => Promise<void>, delayMs: 0 | 100 = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await flush();
}

const WIDTH = 100;
const HEIGHT = 24;

/**
 * Mounts the bridge, then feeds the store, then captures.
 *
 * The order matters: the store holds one print handler at a time, so writes have
 * to happen while the bridge under test is the registered one. In production
 * there is exactly one bridge for the life of the process, so this is also the
 * realistic order.
 */
async function frame(feed: () => void = () => undefined): Promise<string> {
  const { renderer, renderOnce, flush, captureCharFrame } = await testRender(<FullscreenBridge />, {
    width: WIDTH,
    height: HEIGHT,
  });
  await renderOnce();
  feed();
  store.flushOutputBatchNow();
  // The store calls setState from outside React, so the update is not inside an
  // act() scope and renderOnce alone will not see it. flush() drives the
  // reconciler until it settles.
  await flush();
  const text = captureCharFrame();
  renderer.destroy();
  return text;
}

describe("fullscreen bridge", () => {
  beforeEach(() => {
    store.setActivity({ phase: "idle" });
    store.resetRunStats({});
  });

  it("renders a frame at the terminal size before anything has happened", async () => {
    const text = await frame();
    const rows = text.split("\n").filter((row) => row.length > 0);
    expect(rows).toHaveLength(HEIGHT);
    for (const row of rows) expect([...row]).toHaveLength(WIDTH);
  });

  it("puts the model and the context meter in the header from run stats", async () => {
    const text = await frame(() => {
      store.resetRunStats({
        model: "claude-opus-5",
        tokensInContext: 82_100,
        maxContextTokens: 200_000,
        costUSD: 0.042,
      });
    });
    expect(text).toContain("claude-opus-5");
    // 82.1k of 200k is 41%.
    expect(text).toContain("41%");
  });

  it("shows a user turn and an agent reply as separate blocks", async () => {
    const text = await frame(() => {
      store.printOutput({ type: "user", message: "what did I miss", timestamp: new Date() });
      store.printOutput({
        type: "streamContent",
        message: "Four things need you",
        timestamp: new Date(),
      });
    });
    expect(text).toContain("what did I miss");
    expect(text).toContain("Four things need you");
  });

  it("joins consecutive stream chunks into one turn rather than one block each", async () => {
    // The model emits prose in chunks. A block per chunk would make the
    // transcript unscrollable and the markdown unparseable.
    const text = await frame(() => {
      store.printOutput({ type: "streamContent", message: "Half a ", timestamp: new Date() });
      store.printOutput({ type: "streamContent", message: "sentence.", timestamp: new Date() });
    });
    expect(text).toContain("Half a sentence.");
  });

  it("surfaces an error as a notice rather than dropping it", async () => {
    const text = await frame(() => {
      store.printOutput({ type: "error", message: "token expired", timestamp: new Date() });
    });
    expect(text).toContain("token expired");
  });

  it("shows running tools in the live zone with their elapsed time", async () => {
    const text = await frame(() => {
      store.setActivity({
        phase: "tool-execution",
        agentName: "jazz",
        tools: [
          { toolCallId: "1", toolName: "gmail", startedAt: Date.now() - 4_000 },
          { toolCallId: "2", toolName: "web", startedAt: Date.now() - 11_000 },
        ],
      });
    });
    expect(text).toContain("gmail");
    expect(text).toContain("web");
  });

  it("has nothing in the live zone when the agent is idle", async () => {
    const text = await frame(() => {
      store.setActivity({ phase: "idle" });
      store.printOutput({ type: "user", message: "hello", timestamp: new Date() });
    });
    const rows = text.split("\n").filter((row) => row.length > 0);
    // Still a full frame, and the input is still on the second-to-last row.
    expect(rows).toHaveLength(HEIGHT);
  });
  it("renders a completed tool call as a receipt, not a generic notice", async () => {
    // The reducer pushes a rendered ANSI string for the Ink tree and the same
    // result as structured meta. Reading the meta is what makes a settled tool
    // call read as `gmail  4 flagged of 26` rather than as somebody else's
    // layout pasted into the transcript.
    const text = await frame(() => {
      store.printOutput({
        type: "log",
        message: "ignored-ansi-rendering",
        timestamp: new Date(),
        meta: {
          toolReceipt: {
            app: "gmail",
            summary: "4 flagged of 26",
            status: "ok",
            durationMs: 1_900,
          },
        },
      });
    });
    expect(text).toContain("gmail");
    expect(text).toContain("4 flagged of 26");
    // The string the Ink tree would have shown must not leak through.
    expect(text).not.toContain("ignored-ansi-rendering");
  });

  it("keeps the reason and remedy on a failed tool call", async () => {
    const text = await frame(() => {
      store.printOutput({
        type: "log",
        message: "ignored",
        timestamp: new Date(),
        meta: {
          toolReceipt: {
            app: "slack",
            summary: "could not read",
            status: "failed",
            reason: "read-only connection",
          },
        },
      });
    });
    expect(text).toContain("slack");
    expect(text).toContain("read-only connection");
  });
  it("shows connector health in the header once something reports it", async () => {
    // MCP servers are the real connectors jazz has. A failed connection is not
    // fatal — the agent carries on without those tools — so the header is the
    // only place the user would otherwise learn about it.
    const text = await frame(() => {
      store.setConnector("notion", "offline");
      store.setConnector("github", "live");
    });
    expect(text.toLowerCase()).toContain("apps");
  });
  it("routes / to history search instead of typing a slash", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();

    await mockInput.pressKey("/");
    await settleKeypress(flush);
    const opened = captureCharFrame();

    await mockInput.pressKey("ESCAPE");
    await settleKeypress(flush, 100);
    const closed = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);

    // Opening search changes the frame, and Escape puts it back — the slash
    // must not have been typed into the composer instead.
    expect(opened).not.toBe(closed);
    expect(closed).not.toContain("> / ");
  });
  it("draws the wizard menu as the home screen", async () => {
    // The wizard publishes its menu as data alongside the Ink tree, so a
    // renderer that cannot paint an Ink element can still draw the flow. Without
    // this the fullscreen interface could not reach a chat session at all.
    const text = await frame(() => {
      store.setActiveMenu({
        kind: "menu",
        options: [
          { label: "Start chatting", value: "chat" },
          { label: "Create an agent", value: "create" },
        ],
        onSelect: () => undefined,
        onExit: () => undefined,
      });
    });
    expect(text).toContain("Start chatting");
    expect(text).toContain("Create an agent");
    store.setActiveMenu(null);
  });
  it("accepts typing into the composer while a chat prompt is live", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();

    for (const key of ["h", "e", "y"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    const typed = captureCharFrame();

    await mockInput.pressKey("BACKSPACE");
    await settleKeypress(flush);
    const afterBackspace = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);

    expect(typed).toContain("hey");
    expect(afterBackspace).toContain("he");
    expect(afterBackspace).not.toContain("hey");
  });
});

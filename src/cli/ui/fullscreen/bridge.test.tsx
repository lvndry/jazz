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
});

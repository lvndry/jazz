/** @jsxImportSource @opentui/react */
/**
 * Proves the fullscreen interface is actually wired to the live store, rather
 * than only to the sample fixture. Writes go in through the same store methods
 * the presentation service uses, and the assertions read the rendered frame.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Effect } from "effect";
import React from "react";
import { createAccumulator, reduceEvent } from "@/cli/presentation/activity-reducer";
import { InkPresentationService } from "@/cli/presentation/ink-presentation-service";
import { formatMarkdown } from "@/cli/presentation/markdown-formatter";
import { ink } from "@/core/interfaces/terminal";
import { InkTerminalService } from "@/services/terminal";
import packageJson from "../../../../package.json";
import { hydrateTranscriptFromHistory } from "../hydrate-transcript";
import { store } from "../store";
import { THEME } from "../theme";
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

function terminalProducer(): InkTerminalService {
  return Object.create(InkTerminalService.prototype) as InkTerminalService;
}

function presentationProducer(): InkPresentationService {
  return new InkPresentationService(
    {
      showThinking: true,
      showToolExecution: true,
      mode: "rendered",
      colorProfile: "full",
    },
    null,
  );
}

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
  // Store-driven updates dispatch from outside React; one macrotask tick plus a
  // second flush matches settleKeypress and prevents ordering flakes in the full
  // suite when another test left handlers registered on the shared store.
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
  const text = captureCharFrame();
  renderer.destroy();
  return text;
}

function unregisterAllStoreHandlers(): void {
  store.registerPrintOutput(null);
  store.registerUpdateOutput(null);
  store.registerClearOutputs(null);
  store.registerStreamingHandler(null);
  store.registerActivitySetter(null);
  store.registerRunStatsSetter(null);
  store.registerMessageQueueSetter(null);
  store.registerChatBusySetter(null);
  store.registerModeSetter(null);
  store.registerEphemeralRegionsSetter(null);
  store.registerPromptSetter(null);
  store.registerApprovalRequestSetter(null);
  store.registerConnectorsSetter(null);
  store.registerActiveMenuSetter(null);
  store.registerWorkingDirectorySetter(null);
  store.registerInterruptHandler(null);
}

describe("fullscreen bridge", () => {
  const originalChalkLevel = chalk.level;

  // Production has truecolor; `bun test` defaults chalk to level 0, which emits
  // no escape codes at all. Every string the presentation service styles
  // therefore arrives clean in a test and styled in the real app — which is how
  // ANSI escapes leaking into the transcript went unnoticed while producing
  // visibly mangled text on screen. Forcing the level here makes these tests
  // see what a user sees.
  beforeAll(() => {
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = originalChalkLevel;
  });

  beforeEach(() => {
    unregisterAllStoreHandlers();
    store.setActivity({ phase: "idle" });
    store.resetRunStats({});
    store.setPrompt(null);
    store.setApprovalRequest(null);
    store.setActiveMenu(null);
    store.setChatBusy(false);
    store.setWorkingDirectory(null);
    store.clearQueue();
    store.setModeIsYolo(false);
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

  it("hydrates identity into the header without crowding the mark", async () => {
    store.setWorkingDirectory("/tmp/音楽/👨‍👩‍👧‍👦-e\u0301");
    const text = await frame();
    expect(text).toContain("jazz");
    expect(text).not.toContain(`v${packageJson.version}`);
    expect(text).not.toContain("/tmp/音楽/👨‍👩‍👧‍👦-e\u0301");
  });

  it("hydrates a resumed conversation into the visible transcript", async () => {
    const text = await frame(() => {
      hydrateTranscriptFromHistory([
        { role: "system", content: "You are a helpful agent." },
        {
          role: "system",
          content: "Resuming conversation from 8/22/2026, 2:00:00 PM: Standup notes",
        },
        { role: "user", content: "Summarize yesterday's standup" },
        { role: "assistant", content: "The team shipped the resume fix." },
        { role: "tool", content: '{"ok":true}', tool_call_id: "call-1" },
      ]);
    });
    expect(text).toContain("Summarize yesterday's standup");
    expect(text).toContain("The team shipped the resume fix.");
    expect(text).not.toContain("You are a helpful agent.");
    expect(text).not.toContain("Resuming conversation from");
    expect(text).not.toContain('{"ok":true}');
  });

  it("keeps a restored transcript when the next user turn is printed", async () => {
    const text = await frame(() => {
      hydrateTranscriptFromHistory([
        { role: "user", content: "prior question" },
        { role: "assistant", content: "prior answer" },
      ]);
      store.printOutput({ type: "user", message: "follow up", timestamp: new Date() });
    });
    expect(text).toContain("prior question");
    expect(text).toContain("prior answer");
    expect(text).toContain("follow up");
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

  it("derives a meaningful tool operation and current plan step", async () => {
    const text = await frame(() => {
      store.setActivity({
        phase: "tool-execution",
        agentName: "jazz",
        tools: [{ toolCallId: "1", toolName: "gmail_search", startedAt: Date.now() }],
        todoSnapshot: [
          { content: "Inspect inbox", status: "completed" },
          { content: "Rank urgent threads", status: "in_progress" },
          { content: "Draft replies", status: "pending" },
        ],
      });
    });
    expect(text).toContain("gmail");
    expect(text).toContain("search");
    expect(text).toContain("step 2 of 3");
    expect(text).toContain("Rank urgent threads");
  });

  it("ticks turn elapsed time while a run remains active", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setChatBusy(true);
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("0s");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("1s");

    store.setChatBusy(false);
    rendered.renderer.destroy();
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
  it("types a literal slash and opens history search with Ctrl+F", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();

    await mockInput.pressKey("/");
    await settleKeypress(flush);
    const typed = captureCharFrame();

    await mockInput.pressKey("f", { ctrl: true });
    await settleKeypress(flush);
    const opened = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);

    expect(typed).toContain("/");
    expect(opened).toContain("all sessions");
  });

  it("lists slash commands on / and runs the highlighted one with enter", async () => {
    let submitted: string | undefined;
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setPrompt({
      type: "chat",
      message: "",
      resolve: (value) => {
        submitted = String(value);
      },
    });
    await rendered.flush();

    await rendered.mockInput.pressKey("/");
    await settleKeypress(rendered.flush);
    const listed = rendered.captureCharFrame();
    expect(listed).toContain("/agents");
    expect(listed).toContain("/workflows");

    await rendered.mockInput.pressKey("h");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("/help");

    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    rendered.renderer.destroy();
    store.setPrompt(null);

    expect(submitted).toBe("/help");
  });

  it("wraps the slash-command list from the last item back to the first", async () => {
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("/");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("/agents");

    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("/workflows");

    await rendered.mockInput.pressKey("ARROW_DOWN");
    await settleKeypress(rendered.flush, 100);
    const back = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(back).toContain("/agents");
  });

  it("types search from the real sequence and toggles scope with Tab", async () => {
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("f", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await typeInto(rendered.mockInput, rendered.flush, "Hello There");
    expect(rendered.captureCharFrame()).toContain("Hello There");

    await rendered.mockInput.pressKey("TAB");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("this session");

    rendered.renderer.destroy();
    store.setPrompt(null);
  });

  it("recalls sent messages with up from an empty composer", async () => {
    store.pushInputHistory("earlier turn");
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("earlier turn");
  });

  it("queues, recalls, and clears after the chat prompt is cleared for a busy turn", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await rendered.flush();
    store.setChatBusy(true);
    store.setPrompt(null);
    await rendered.flush();

    await typeInto(rendered.mockInput, rendered.flush, "follow up");
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("1 queued");
    expect(store.getMessageQueueSnapshot()).toEqual(["follow up"]);

    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("follow up");
    expect(store.getMessageQueueSnapshot()).toEqual([]);

    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("x", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    expect(store.getMessageQueueSnapshot()).toEqual([]);
    expect(rendered.captureCharFrame()).not.toContain("queued");

    rendered.renderer.destroy();
    store.setChatBusy(false);
    store.setPrompt(null);
  });

  it("toggles safe/yolo mode and warning-colors yolo in the footer", async () => {
    const rendered = await liveComposer();
    expect(rendered.captureCharFrame()).toContain("safe");

    await rendered.mockInput.pressKey("TAB", { shift: true });
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("yolo");
    const yoloSpan = rendered
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("yolo"));
    expect(yoloSpan).toBeDefined();
    const [red, green, blue] = yoloSpan!.fg.toInts();
    const color = `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
    expect(color).toBe(THEME.warning.toUpperCase());

    rendered.renderer.destroy();
    store.setPrompt(null);
    store.setModeIsYolo(false);
  });

  it("moves the painted caret with focus and preserves focus-return typing", async () => {
    const rendered = await liveComposer();
    const caretColor = RGBA.fromHex(THEME.prompt).toInts().slice(0, 3).join(",");
    const hasCaret = (): boolean =>
      rendered
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.bg.toInts().slice(0, 3).join(",") === caretColor);
    expect(hasCaret()).toBe(true);

    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    expect(hasCaret()).toBe(false);

    await rendered.mockInput.pressKey("z");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("z");
    expect(hasCaret()).toBe(true);

    rendered.renderer.destroy();
    store.setPrompt(null);
  });

  it("interrupts streaming-only work with Esc Esc", async () => {
    let interrupted = 0;
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setInterruptHandler(() => {
      interrupted += 1;
    });
    store.appendStream("response", "still streaming");
    await rendered.flush();

    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    expect(interrupted).toBe(1);

    store.finalizeStream();
    store.setInterruptHandler(null);
    rendered.renderer.destroy();
  });

  it("interrupts busy work with Esc Esc after the chat prompt is cleared", async () => {
    let interrupted = 0;
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    store.setChatBusy(true);
    store.setPrompt(null);
    store.setInterruptHandler(() => {
      interrupted += 1;
    });
    await rendered.flush();

    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);

    expect(interrupted).toBe(1);
    store.setInterruptHandler(null);
    store.setChatBusy(false);
    rendered.renderer.destroy();
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

  it("draws live home readiness rows instead of an empty setup list", async () => {
    const text = await frame(() => {
      store.setActiveMenu({
        kind: "menu",
        requirements: [
          {
            label: "agent",
            ready: false,
            detail: "none yet",
            remedy: "create your first one below",
          },
        ],
        options: [{ label: "Create agent", value: "create-agent" }],
        onSelect: () => undefined,
        onExit: () => undefined,
      });
    });
    expect(text).toContain("agent");
    expect(text).toContain("create your first one below");
    expect(text).toContain("Press enter on");
    store.setActiveMenu(null);
  });

  it("draws the agent picker with the title that says why the list is open", async () => {
    const text = await frame(() => {
      store.setActiveMenu({
        kind: "agents",
        title: "delete an agent",
        action: "delete",
        agents: [
          { id: "a1", name: "Basil", model: "claude-sonnet-4", lastUsed: true },
          { id: "a2", name: "Cass", model: "gpt-5" },
        ],
        onSelect: () => undefined,
        onExit: () => undefined,
      });
    });
    expect(text).toContain("delete an agent");
    expect(text).toContain("Basil");
    expect(text).toContain("enter delete");
    expect(text).not.toContain("enter start");
    store.setActiveMenu(null);
  });

  it("returns from the agent picker on escape without selecting", async () => {
    const selected: string[] = [];
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 28 });
    await rendered.renderOnce();
    store.setActiveMenu({
      kind: "agents",
      title: "pick an agent",
      action: "start",
      agents: [{ id: "a1", name: "Basil", model: "claude-sonnet-4" }],
      onSelect: (value) => selected.push(value),
      onExit: () => selected.push("EXIT"),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    rendered.renderer.destroy();
    store.setActiveMenu(null);
    expect(selected).toEqual(["EXIT"]);
  });

  it("starts the selected agent from the picker with enter", async () => {
    const selected: string[] = [];
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 28 });
    await rendered.renderOnce();
    store.setActiveMenu({
      kind: "agents",
      title: "pick an agent",
      action: "start",
      agents: [
        { id: "a1", name: "Basil", model: "claude-sonnet-4" },
        { id: "a2", name: "Cass", model: "gpt-5" },
      ],
      onSelect: (value) => selected.push(value),
      onExit: () => selected.push("EXIT"),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ARROW_DOWN");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    rendered.renderer.destroy();
    store.setActiveMenu(null);
    expect(selected).toEqual(["a2"]);
  });

  it("draws every agent on the list-agents screen", async () => {
    const text = await frame(() => {
      store.setActiveMenu({
        kind: "agents",
        title: "agents",
        action: "back",
        browse: true,
        agents: [
          { id: "a1", name: "doitall", model: "claude-sonnet-4" },
          { id: "a2", name: "qwen-coder", model: "qwen2.5-coder" },
        ],
        onSelect: () => undefined,
        onExit: () => undefined,
      });
    });
    expect(text).toContain("doitall");
    expect(text).toContain("qwen-coder");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("qwen2.5-coder");
    expect(text).toContain("enter back");
    expect(text).not.toContain("enter start");
    store.setActiveMenu(null);
  });

  it("leaves the list-agents screen on enter or escape without selecting", async () => {
    const selected: string[] = [];
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 28 });
    await rendered.renderOnce();
    store.setActiveMenu({
      kind: "agents",
      title: "agents",
      action: "back",
      browse: true,
      agents: [
        { id: "a1", name: "doitall", model: "claude-sonnet-4" },
        { id: "a2", name: "qwen-coder", model: "qwen2.5-coder" },
      ],
      onSelect: (value) => selected.push(value),
      onExit: () => selected.push("EXIT"),
    });
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("doitall");

    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(selected).toEqual(["EXIT"]);

    selected.length = 0;
    store.setActiveMenu({
      kind: "agents",
      title: "agents",
      action: "back",
      browse: true,
      agents: [{ id: "a1", name: "doitall", model: "claude-sonnet-4" }],
      onSelect: (value) => selected.push(value),
      onExit: () => selected.push("EXIT"),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);

    rendered.renderer.destroy();
    store.setActiveMenu(null);
    expect(selected).toEqual(["EXIT"]);
  });

  it("says what to do when the agent list is empty", async () => {
    const text = await frame(() => {
      store.setActiveMenu({
        kind: "agents",
        title: "pick an agent",
        action: "start",
        agents: [],
        onSelect: () => undefined,
        onExit: () => undefined,
      });
    });
    expect(text).toContain("No agents yet.");
    expect(text).toContain("Create agent");
    expect(text).toContain("esc");
    expect(text).not.toContain("move");
    store.setActiveMenu(null);
  });

  it("hands an Ink-only custom screen to the legacy renderer", async () => {
    let fallbackRequests = 0;
    const unregisterFallback = store.registerRendererFallbackHandler(() => {
      fallbackRequests += 1;
    });
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();

    store.setCustomView(React.createElement(React.Fragment, null, "legacy-only"));
    await rendered.flush();
    await rendered.flush();

    rendered.renderer.destroy();
    store.setCustomView(null);
    unregisterFallback();
    expect(fallbackRequests).toBe(1);
  });

  it("keeps a renderer-neutral menu fullscreen when an Ink view is also published", async () => {
    let fallbackRequests = 0;
    const unregisterFallback = store.registerRendererFallbackHandler(() => {
      fallbackRequests += 1;
    });
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();

    store.setCustomView(React.createElement(React.Fragment, null, "legacy-copy"));
    store.setActiveMenu({
      kind: "menu",
      options: [{ label: "Stay fullscreen", value: "stay" }],
      onSelect: () => undefined,
      onExit: () => undefined,
    });
    await rendered.flush();
    await Promise.resolve();

    expect(rendered.captureCharFrame()).toContain("Stay fullscreen");
    expect(fallbackRequests).toBe(0);

    rendered.renderer.destroy();
    store.setCustomView(null);
    store.setActiveMenu(null);
    unregisterFallback();
  });

  it("keeps the composer usable after a user message and an agent reply", async () => {
    const rendered = await liveComposer();
    store.printOutput({
      type: "user",
      message: "what is on Thursday?",
      timestamp: new Date(),
    });
    store.printOutput({
      type: "streamContent",
      message: "Thursday is free after two.",
      timestamp: new Date(),
    });
    store.setChatBusy(true);
    store.flushOutputBatchNow();
    await rendered.flush();
    store.setChatBusy(false);
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await rendered.flush();

    await rendered.mockInput.pressKey("x");
    await settleKeypress(rendered.flush);
    const typed = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);

    expect(typed).toContain("x");
    expect(typed).toContain("enter to send");
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

  it("pastes into the composer, including newlines, without submitting", async () => {
    let submitted: string | undefined;
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setPrompt({
      type: "chat",
      message: "",
      resolve: (value) => {
        submitted = String(value);
      },
    });
    await rendered.flush();

    await rendered.mockInput.pasteBracketedText("hello\nthere");
    await settleKeypress(rendered.flush, 100);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);

    expect(frame).toContain("hello");
    expect(frame).toContain("there");
    expect(submitted).toBeUndefined();
  });

  it("inserts a paste at the caret rather than at the end", async () => {
    const rendered = await liveComposer();
    await typeInto(rendered.mockInput, rendered.flush, "ab");
    await rendered.mockInput.pressKey("ARROW_LEFT");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pasteBracketedText("XY");
    await settleKeypress(rendered.flush, 100);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("aXYb");
  });

  it("drives text and password producers through the store and overlay", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const producer = terminalProducer();

    const textResult = Effect.runPromise(
      producer.ask("Agent name", { simple: true, cancellable: true }),
    );
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("Agent name");
    await typeInto(rendered.mockInput, rendered.flush, "Scout");
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await textResult).toBe("Scout");

    const passwordResult = Effect.runPromise(producer.password("API key"));
    await rendered.flush();
    await typeInto(rendered.mockInput, rendered.flush, "topsecret");
    const masked = rendered.captureCharFrame();
    expect(masked).toContain("API key");
    expect(masked).not.toContain("topsecret");
    expect(masked).toContain("***secret");
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await passwordResult).toBe("topsecret");

    rendered.renderer.destroy();
  });

  it("masks a secret text prompt while typing and still submits the full key", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const producer = terminalProducer();
    const apiKey = "c9706a74-71d7-4523-8044-29b01abff127";

    const secretResult = Effect.runPromise(
      producer.ask("Enter API Key for linkup:", { simple: true, secret: true }),
    );
    await rendered.flush();
    await typeInto(rendered.mockInput, rendered.flush, apiKey);
    const live = rendered.captureCharFrame();
    expect(live).toContain("***bff127");
    expect(live).not.toContain(apiKey);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await secretResult).toBe(apiKey);

    rendered.renderer.destroy();
  });

  it("rejects a secret API key prompt on escape and keeps the parent flow alive", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const producer = terminalProducer();

    const cancelledKey = Effect.runPromise(
      producer.ask("Enter API Key for tavily:", { simple: true, secret: true }),
    );
    await rendered.flush();
    const promptFrame = rendered.captureCharFrame();
    expect(promptFrame).toContain("Enter API Key for tavily:");
    expect(promptFrame).toContain("to go back");
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    expect(await cancelledKey).toBeUndefined();

    const selected = Effect.runPromise(
      producer.select("Which web search provider would you like to use?", {
        choices: [
          { name: "Tavily", value: "tavily" },
          { name: "Linkup", value: "linkup" },
        ],
      }),
    );
    await rendered.flush();
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain(
      "Which web search provider would you like to use?",
    );
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await selected).toBe("tavily");

    rendered.renderer.destroy();
  });

  it("drives select, checkbox, and questionnaire values from their producers", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: 30 });
    await rendered.renderOnce();
    const terminal = terminalProducer();
    const enabledValue = { id: 2 };

    const selected = Effect.runPromise(
      terminal.select("Choose one", {
        choices: [
          { name: "Disabled", value: { id: 1 }, disabled: true },
          { name: "Enabled", value: enabledValue },
        ],
      }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await selected).toBe(enabledValue);

    const defaultValue = { id: 4 };
    const defaulted = Effect.runPromise(
      terminal.select("Choose the default", {
        choices: [
          { name: "First", value: { id: 3 } },
          { name: "Default", value: defaultValue },
        ],
        default: defaultValue,
      }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await defaulted).toBe(defaultValue);

    const checked = Effect.runPromise(
      terminal.checkbox("Choose several", {
        choices: [
          { name: "Alpha", value: "alpha" },
          { name: "Beta", value: "beta" },
        ],
        default: ["beta"],
      }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey(" ");
    await settleKeypress(rendered.flush);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await checked).toEqual(["alpha", "beta"]);

    const emptyChecked = Effect.runPromise(
      terminal.checkbox("Choose none", {
        choices: [
          { name: "Alpha", value: "alpha" },
          { name: "Beta", value: "beta" },
        ],
      }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await emptyChecked).toEqual([]);

    const presentation = presentationProducer();
    const questionnaire = Effect.runPromise(
      presentation.requestUserInput({
        question: "Which route?",
        suggestions: [
          { label: "North", value: "north" },
          { label: "South", value: "south" },
        ],
        allowCustom: false,
      }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey("ARROW_DOWN");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    expect(await questionnaire).toBe("south");

    rendered.renderer.destroy();
  });

  it("drives the filepicker producer through filesystem scan and selection", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-filepicker-"));
    const selectedPath = path.join(basePath, "choice.txt");
    await fs.writeFile(selectedPath, "pick me");
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: 30 });
    await rendered.renderOnce();

    try {
      const result = Effect.runPromise(
        presentationProducer().requestFilePicker({
          message: "Pick a file",
          basePath,
          extensions: ["txt"],
        }),
      );
      await rendered.flush();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (rendered.captureCharFrame().includes("choice.txt")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await rendered.flush();
      }
      expect(rendered.captureCharFrame()).toContain("choice.txt");
      await rendered.mockInput.pressKey("RETURN");
      await settleKeypress(rendered.flush, 100);
      expect(await result).toBe(selectedPath);
    } finally {
      rendered.renderer.destroy();
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it("hydrates a prompt published before the fullscreen bridge mounts", async () => {
    store.setPrompt({
      type: "text",
      message: "Already waiting",
      resolve: () => undefined,
    });
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("Already waiting");
    rendered.renderer.destroy();
  });

  it("handles hidden, confirm, search, and cancellable prompt keys", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const resolved: unknown[] = [];

    store.setPrompt({
      type: "hidden",
      message: "Continue",
      resolve: (value) => resolved.push(value),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);

    store.setPrompt({
      type: "hidden",
      message: "Continue",
      resolve: (value) => resolved.push(value),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);

    store.setPrompt({
      type: "confirm",
      message: "Proceed?",
      options: { defaultValue: false },
      resolve: (value) => resolved.push(value),
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);

    store.setPrompt({
      type: "search",
      message: "Find one",
      options: {
        choices: [
          { label: "Blocked banana", value: "blocked", disabled: true },
          { label: "Apple", value: "apple" },
          { label: "Banana", value: "banana" },
        ],
      },
      resolve: (value) => resolved.push(value),
    });
    await rendered.flush();
    await typeInto(rendered.mockInput, rendered.flush, "Banana");
    expect(rendered.captureCharFrame()).toContain("Banana");
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);

    let cancelled = false;
    store.setPrompt({
      type: "select",
      message: "Cancel me",
      options: { choices: [{ label: "Only", value: "only" }] },
      resolve: () => undefined,
      reject: () => {
        cancelled = true;
      },
    });
    await rendered.flush();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);

    rendered.renderer.destroy();
    expect(resolved).toEqual(["", "", true, "banana"]);
    expect(cancelled).toBe(true);
  });

  it("windows a long select, filters by typing, and wraps selection", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: 28 });
    await rendered.renderOnce();
    const choices = Array.from({ length: 24 }, (_, index) => ({
      label: `Provider ${String(index + 1).padStart(2, "0")}`,
      value: `provider-${String(index + 1)}`,
    }));
    const selected: unknown[] = [];

    store.setPrompt({
      type: "select",
      message: "Which LLM provider would you like to use?",
      options: { choices },
      resolve: (value) => selected.push(value),
    });
    await rendered.flush();
    const opened = rendered.captureCharFrame();
    expect(opened).toContain("Provider 01");
    expect(opened).toContain("Provider 10");
    expect(opened).not.toContain("Provider 11");
    expect(opened).toContain("Type to filter");

    await rendered.mockInput.pressKey("ARROW_UP");
    await settleKeypress(rendered.flush, 100);
    const wrapped = rendered.captureCharFrame();
    expect(wrapped).toContain("Provider 24");
    expect(wrapped).not.toContain("Provider 01");

    await typeInto(rendered.mockInput, rendered.flush, "03");
    const filtered = rendered.captureCharFrame();
    expect(filtered).toContain("Provider 03");
    expect(filtered).not.toContain("Provider 24");
    expect(filtered).not.toContain("Provider 01");

    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);
    rendered.renderer.destroy();
    expect(selected).toEqual(["provider-3"]);
  });

  it("navigates the wizard menu with arrows and selects with enter", async () => {
    // The wizard menu renders through Home, which is content passed *into*
    // App as overrideContent rather than returned in App's place — because
    // App's own useKeyboard call has to stay mounted for anything to receive a
    // key at all. An earlier version returned the menu screen directly from
    // this component, above App, so nothing on it could be navigated: not
    // arrows, not enter, not even Ctrl+C.
    const selected: string[] = [];
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: 100, height: 28 },
    );
    await renderOnce();
    store.setActiveMenu({
      kind: "menu",
      options: [
        { label: "Start chatting", value: "chat" },
        { label: "Create an agent", value: "create" },
        { label: "Exit", value: "exit" },
      ],
      onSelect: (value) => selected.push(value),
      onExit: () => selected.push("EXIT-CALLED"),
    });
    await flush();
    const before = captureCharFrame();

    await mockInput.pressKey("ARROW_DOWN");
    await settleKeypress(flush, 100);
    const afterDown = captureCharFrame();

    await mockInput.pressKey("RETURN");
    await settleKeypress(flush, 100);

    renderer.destroy();
    store.setActiveMenu(null);

    expect(afterDown).not.toBe(before);
    expect(selected).toEqual(["create"]);
  });

  it("navigates the wizard from application-cursor and vim keys", async () => {
    const selected: string[] = [];
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 28 });
    await rendered.renderOnce();
    store.setActiveMenu({
      kind: "menu",
      options: [
        { label: "Start chatting", value: "chat" },
        { label: "Create an agent", value: "create" },
        { label: "Exit", value: "exit" },
      ],
      onSelect: (value) => selected.push(value),
      onExit: () => undefined,
    });
    await rendered.flush();

    await rendered.mockInput.pressKey("\x1bOB");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("j");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("RETURN");
    await settleKeypress(rendered.flush, 100);

    rendered.renderer.destroy();
    store.setActiveMenu(null);
    expect(selected).toEqual(["exit"]);
  });

  it("scrolls older transcript lines into view with the mouse wheel", async () => {
    const rendered = await liveComposer();
    for (let index = 0; index < 40; index++) {
      store.printOutput({
        type: "log",
        message: `line-${String(index).padStart(2, "0")} unique-marker`,
        timestamp: new Date(),
      });
    }
    store.flushOutputBatchNow();
    await rendered.flush();
    await settleKeypress(rendered.flush, 100);
    const atBottom = rendered.captureCharFrame();
    expect(atBottom).toContain("line-39");
    expect(atBottom).not.toContain("line-00");

    for (let step = 0; step < 40; step++) {
      await rendered.mockMouse.scroll(20, 8, "up");
      await settleKeypress(rendered.flush);
    }
    const scrolled = rendered.captureCharFrame();
    expect(scrolled).toContain("line-00");
    expect(scrolled).not.toContain("line-39");

    for (let step = 0; step < 40; step++) {
      await rendered.mockMouse.scroll(20, 8, "down");
      await settleKeypress(rendered.flush);
    }
    const back = rendered.captureCharFrame();

    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(back).toContain("line-39");
    expect(back).not.toContain("line-00");
  });

  it("jumps to the composer when typing from the transcript", async () => {
    const rendered = await liveComposer();
    for (let index = 0; index < 8; index++) {
      store.printOutput({
        type: "log",
        message: `line-${String(index).padStart(2, "0")} unique-marker`,
        timestamp: new Date(),
      });
    }
    store.flushOutputBatchNow();
    await rendered.flush();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("type to input");

    await rendered.mockInput.pressKey("a");
    await settleKeypress(rendered.flush);
    const typed = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(typed).toContain("a");
    expect(typed).toContain("enter to send");
  });

  it("pastes into the composer while the transcript has focus", async () => {
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("ESCAPE");
    await settleKeypress(rendered.flush, 100);
    expect(rendered.captureCharFrame()).toContain("type to input");

    await rendered.mockInput.pasteBracketedText("pasted-while-scrolled");
    await settleKeypress(rendered.flush);
    const pasted = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(pasted).toContain("pasted-while-scrolled");
    expect(pasted).toContain("enter to send");
  });

  it("accepts only denial until an approval has armed", async () => {
    const decisions: string[] = [];
    const { renderer, renderOnce, flush, mockInput } = await testRender(<FullscreenBridge />, {
      width: 100,
      height: 28,
    });
    await renderOnce();
    store.setPrompt({
      type: "select",
      message: "Approve this action?",
      options: { choices: [] },
      resolve: (value) => decisions.push(String(value)),
    });
    store.setApprovalRequest({
      toolName: "calendar_create",
      executeToolName: "calendar_create",
      message: "This invitation will be sent immediately.",
      args: { account: "user@example.com", title: "Planning" },
    });
    await flush();

    await mockInput.pressKey("RETURN");
    await settleKeypress(flush);
    await mockInput.pressKey("a");
    await settleKeypress(flush);
    expect(decisions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    await mockInput.pressKey("RETURN");
    await settleKeypress(flush);

    renderer.destroy();
    store.setApprovalRequest(null);
    store.setPrompt(null);
    expect(decisions).toEqual(["yes"]);
  });

  it("keeps immediate rejection available and renders every approval field", async () => {
    const decisions: string[] = [];
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: 100, height: 40 },
    );
    await renderOnce();
    store.setPrompt({
      type: "select",
      message: "Approve this action?",
      options: { choices: [] },
      resolve: (value) => decisions.push(String(value)),
    });
    store.setApprovalRequest({
      toolName: "calendar_create",
      executeToolName: "calendar_create",
      message: "This invitation will be sent immediately.",
      args: {
        account: "user@example.com",
        field1: "one",
        field2: "two",
        field3: "three",
        field4: "four",
        field5: "five",
        field6: "six",
        field7: "seven",
        field8: "eight",
        field9: "nine",
      },
    });
    await flush();
    expect(captureCharFrame()).toContain("field9");

    await mockInput.pressKey("ESCAPE");
    await settleKeypress(flush, 100);

    renderer.destroy();
    store.setApprovalRequest(null);
    store.setPrompt(null);
    expect(decisions).toEqual(["no"]);
  });

  it("lets the user inspect overflowed approval fields before deciding", async () => {
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 16 });
    await rendered.renderOnce();
    store.setPrompt({
      type: "select",
      message: "Approve this action?",
      options: { choices: [] },
      resolve: () => undefined,
    });
    store.setApprovalRequest({
      toolName: "calendar_create",
      executeToolName: "calendar_create",
      message: "This invitation will be sent immediately.",
      args: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`field${String(index + 1)}`, index + 1]),
      ),
    });
    await rendered.flush();
    expect(rendered.captureCharFrame()).not.toContain("field12");

    for (let index = 0; index < 7; index++) {
      await rendered.mockInput.pressKey("ARROW_DOWN");
      await settleKeypress(rendered.flush, 100);
    }
    expect(rendered.captureCharFrame()).toContain("field12");

    rendered.renderer.destroy();
    store.setApprovalRequest(null);
    store.setPrompt(null);
  });

  it("always-allows only the current command scope for shell approvals", async () => {
    const decisions: string[] = [];
    const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 24 });
    await rendered.renderOnce();
    store.setPrompt({
      type: "select",
      message: "Approve this action?",
      options: {
        choices: [
          { label: "Yes", value: "yes" },
          { label: "Always command", value: "always_command" },
          { label: "Always tool", value: "always_tool" },
        ],
      },
      resolve: (value) => decisions.push(String(value)),
    });
    store.setApprovalRequest({
      toolName: "execute_command",
      executeToolName: "execute_command",
      message: "This command will modify the working tree.",
      args: { command: "git add src/app.ts" },
    });
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("always allow git add");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rendered.flush();
    await rendered.mockInput.pressKey("a");
    await settleKeypress(rendered.flush);

    rendered.renderer.destroy();
    store.setApprovalRequest(null);
    store.setPrompt(null);
    expect(decisions).toEqual(["always_command"]);
  });

  // Ctrl+A and Cmd+A are "go to start of line" in the composer. The allowlist
  // `a` writes outlives the turn, so a caret keystroke must never grant it.
  it("does not always-allow on a modified `a`", async () => {
    const modified: readonly (string | Record<string, boolean>)[] = [
      { ctrl: true },
      { meta: true },
      // The raw bytes the real terminals send: the Ctrl+A control code, and
      // kitty's CSI-u encoding of Ctrl+A and Cmd+A.
      "\x01",
      "\x1b[97;5u",
      "\x1b[97;9u",
    ];
    for (const key of modified) {
      const decisions: string[] = [];
      const rendered = await testRender(<FullscreenBridge />, { width: 100, height: 24 });
      await rendered.renderOnce();
      store.setPrompt({
        type: "select",
        message: "Approve this action?",
        options: {
          choices: [
            { label: "Yes", value: "yes" },
            { label: "Always command", value: "always_command" },
          ],
        },
        resolve: (value) => decisions.push(String(value)),
      });
      store.setApprovalRequest({
        toolName: "execute_command",
        executeToolName: "execute_command",
        message: "This command will modify the working tree.",
        args: { command: "git push --force" },
      });
      await rendered.flush();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rendered.flush();
      if (typeof key === "string") await rendered.mockInput.pressKey(key);
      else await rendered.mockInput.pressKey("a", key);
      await settleKeypress(rendered.flush);

      rendered.renderer.destroy();
      store.setApprovalRequest(null);
      store.setPrompt(null);
      expect(decisions).toEqual([]);
    }
  });

  it("stops a run on Ctrl+C from a control byte or the letter+flag shape", async () => {
    for (const key of ["\x03", { name: "c", ctrl: true }] as const) {
      let interrupted = 0;
      const originalKill = process.kill;
      const signals: string[] = [];
      process.kill = ((...args: unknown[]) => {
        signals.push(String(args[1] ?? ""));
        return true;
      }) as typeof process.kill;

      const rendered = await testRender(<FullscreenBridge />, {
        width: WIDTH,
        height: HEIGHT,
        exitOnCtrlC: false,
      });
      await rendered.renderOnce();
      store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
      store.setChatBusy(true);
      store.setInterruptHandler(() => {
        interrupted += 1;
      });
      await rendered.flush();
      await typeInto(rendered.mockInput, rendered.flush, "queued");

      if (typeof key === "string") await rendered.mockInput.pressKey(key);
      else await rendered.mockInput.pressKey(key.name, { ctrl: key.ctrl });
      await settleKeypress(rendered.flush, 100);
      const frame = rendered.captureCharFrame();

      process.kill = originalKill;
      store.setInterruptHandler(null);
      store.setChatBusy(false);
      store.setPrompt(null);
      rendered.renderer.destroy();

      expect(interrupted).toBe(1);
      expect(signals).toEqual([]);
      expect(frame).toContain("queued");
      expect(frame).not.toMatch(/queuedc/);
    }
  });

  it("quits the TUI at idle on Ctrl+C from a control byte or the letter+flag shape", async () => {
    for (const key of ["\x03", { name: "c", ctrl: true }] as const) {
      const originalKill = process.kill;
      const signals: string[] = [];
      process.kill = ((...args: unknown[]) => {
        signals.push(String(args[1] ?? ""));
        return true;
      }) as typeof process.kill;

      const rendered = await liveComposer();
      if (typeof key === "string") await rendered.mockInput.pressKey(key);
      else await rendered.mockInput.pressKey(key.name, { ctrl: key.ctrl });
      await settleKeypress(rendered.flush, 100);

      process.kill = originalKill;
      rendered.renderer.destroy();
      store.setPrompt(null);

      expect(signals).toEqual(["SIGINT"]);
    }
  });

  it("Ctrl+C reaches the handler even while a modal owns the keyboard", async () => {
    // The menu's own catch-all — consuming any key it does not recognise, so an
    // unrecognised key does not leak into the composer behind it — was placed
    // ahead of the Ctrl+C check and swallowed Ctrl+C along with everything
    // else. Ctrl+C is checked first now, specifically so no future modal can
    // make the same mistake.
    const { renderer, renderOnce, flush, mockInput } = await testRender(<FullscreenBridge />, {
      width: 100,
      height: 28,
    });
    await renderOnce();
    store.setActiveMenu({
      kind: "menu",
      options: [{ label: "x", value: "x" }],
      onSelect: () => undefined,
      onExit: () => undefined,
    });
    await flush();

    const originalKill = process.kill;
    let killed = false;
    process.kill = ((..._args: unknown[]) => {
      killed = true;
      return true;
    }) as typeof process.kill;

    await mockInput.pressKey("c", { ctrl: true });
    await settleKeypress(flush, 100);

    process.kill = originalKill;
    renderer.destroy();
    store.setActiveMenu(null);
    expect(killed).toBe(true);
  });

  it("does not interrupt or quit on Cmd+C or Ctrl+Shift+C", async () => {
    const chords = [
      "\x1b[99;9u",
      "\x1b[99;6u",
      { name: "c", super: true },
      { name: "c", ctrl: true, shift: true },
    ] as const;
    for (const key of chords) {
      let interrupted = 0;
      const originalKill = process.kill;
      const signals: string[] = [];
      process.kill = ((...args: unknown[]) => {
        signals.push(String(args[1] ?? ""));
        return true;
      }) as typeof process.kill;

      const rendered = await testRender(<FullscreenBridge />, {
        width: WIDTH,
        height: HEIGHT,
        exitOnCtrlC: false,
        kittyKeyboard: true,
      });
      await rendered.renderOnce();
      store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
      store.setChatBusy(true);
      store.setInterruptHandler(() => {
        interrupted += 1;
      });
      await rendered.flush();
      await typeInto(rendered.mockInput, rendered.flush, "queued");

      if (typeof key === "string") await rendered.mockInput.pressKey(key);
      else await rendered.mockInput.pressKey(key.name, key);
      await settleKeypress(rendered.flush, 100);
      const frame = rendered.captureCharFrame();

      process.kill = originalKill;
      store.setInterruptHandler(null);
      store.setChatBusy(false);
      store.setPrompt(null);
      rendered.renderer.destroy();

      expect(interrupted).toBe(0);
      expect(signals).toEqual([]);
      expect(frame).toContain("queued");
      expect(frame).not.toMatch(/queuedc/);
    }
  });

  it("does not quit the TUI at idle on Cmd+C or Ctrl+Shift+C", async () => {
    const chords = [
      "\x1b[99;9u",
      "\x1b[99;6u",
      { name: "c", super: true },
      { name: "c", ctrl: true, shift: true },
    ] as const;
    for (const key of chords) {
      const originalKill = process.kill;
      const signals: string[] = [];
      process.kill = ((...args: unknown[]) => {
        signals.push(String(args[1] ?? ""));
        return true;
      }) as typeof process.kill;

      const rendered = await testRender(<FullscreenBridge />, {
        width: WIDTH,
        height: HEIGHT,
        exitOnCtrlC: false,
        kittyKeyboard: true,
      });
      await rendered.renderOnce();
      store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
      await rendered.flush();
      if (typeof key === "string") await rendered.mockInput.pressKey(key);
      else await rendered.mockInput.pressKey(key.name, key);
      await settleKeypress(rendered.flush, 100);

      process.kill = originalKill;
      rendered.renderer.destroy();
      store.setPrompt(null);

      expect(signals).toEqual([]);
    }
  });

  it("space inserts a literal space rather than being dropped", async () => {
    // This keyboard library reports space as `name: "space"`, not the literal
    // character — every other printable key's name already is the character
    // it types, which is what made this one easy to miss.
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();
    for (const key of ["h", "i"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    await mockInput.pressKey(" ");
    await settleKeypress(flush);
    for (const key of ["t", "h", "e", "r", "e"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    const frame = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("hi there");
  });

  it("left and right arrows move the caret, so mid-word insertion lands correctly", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();
    for (const key of ["c", "a", "t"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    // Caret is after "cat"; two lefts put it between "c" and "a".
    await mockInput.pressKey("ARROW_LEFT");
    await settleKeypress(flush, 100);
    await mockInput.pressKey("ARROW_LEFT");
    await settleKeypress(flush, 100);
    await mockInput.pressKey("h");
    await settleKeypress(flush);
    const frame = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("chat");
  });

  it("undoes a typed word and shift-selects so the next key replaces it", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();
    for (const key of ["c", "a", "t"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    await mockInput.pressKey("z", { ctrl: true });
    await settleKeypress(flush, 100);
    expect(captureCharFrame()).not.toContain("cat");

    for (const key of ["c", "a", "t"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    await mockInput.pressKey("ARROW_LEFT", { shift: true });
    await settleKeypress(flush, 100);
    await mockInput.pressKey("ARROW_LEFT", { shift: true });
    await settleKeypress(flush, 100);
    await mockInput.pressKey("ARROW_LEFT", { shift: true });
    await settleKeypress(flush, 100);
    await mockInput.pressKey("x");
    await settleKeypress(flush);
    const frame = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("x");
    expect(frame).not.toContain("cat");
  });

  it("option+Backspace (reported as meta) deletes the previous word", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();
    for (const key of ["h", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    await mockInput.pressKey("BACKSPACE", { meta: true });
    await settleKeypress(flush, 100);
    const frame = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("hello");
    expect(frame).not.toContain("world");
  });

  it("Ctrl+Backspace also deletes the previous word", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <FullscreenBridge />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await flush();
    for (const key of ["f", "o", "o", " ", "b", "a", "r"]) {
      await mockInput.pressKey(key);
      await settleKeypress(flush);
    }
    await mockInput.pressKey("BACKSPACE", { ctrl: true });
    await settleKeypress(flush, 100);
    const frame = captureCharFrame();
    renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("foo");
    expect(frame).not.toContain("bar");
  });
  it("shows the real answer when a response completes without streaming a chunk", async () => {
    // A short, fast reply is the common way to hit this: the provider returns
    // the whole answer before any text_chunk event fires, so
    // ink-presentation-service.ts's non-streaming path wraps it in an Ink
    // element instead of a plain string. `String()` on that element is where
    // "[object Object]" came from. The fix carries the real text alongside it
    // in `meta.plainText`, which the bridge now prefers.
    const text = await frame(() => {
      store.printOutput({
        type: "log",
        message: { _tag: "ink", node: { anything: "not renderable outside Ink" } } as never,
        meta: { plainText: "I'm doing well, thanks for asking!" },
        timestamp: new Date(),
      });
    });
    expect(text).toContain("I'm doing well, thanks for asking!");
    expect(text).not.toContain("[object Object]");
  });

  it("never renders [object Object], even with no plainText fallback available", async () => {
    // The defensive floor: textOf() must never call String() on a non-string
    // message, because no object shape in this codebase has a meaningful
    // default toString(). Silence is the correct degradation, not garbage.
    const text = await frame(() => {
      store.printOutput({
        type: "log",
        message: { _tag: "ink", node: {} } as never,
        timestamp: new Date(),
      });
    });
    expect(text).not.toContain("[object Object]");
  });
  /** Types a literal string into a live composer, one real keypress each. */
  async function typeInto(
    mockInput: { pressKey: (key: string, mods?: object) => void },
    flush: () => Promise<void>,
    text: string,
  ): Promise<void> {
    for (const character of text) {
      await mockInput.pressKey(character);
      await settleKeypress(flush);
    }
  }

  async function liveComposer() {
    const rendered = await testRender(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
    await rendered.flush();
    return rendered;
  }

  it("types capital letters as capitals", async () => {
    // `key.name` is lowercased for a shifted letter — "X" arrives as
    // `name: "x"` with `shift: true` — so a composer built on `name` types
    // everything in lower case. `sequence` carries the real character.
    const rendered = await liveComposer();
    await typeInto(rendered.mockInput, rendered.flush, "Hello World");
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("Hello World");
  });

  it("keeps multi-code-point graphemes and pasted text", async () => {
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("👨‍👩‍👧‍👦");
    await settleKeypress(rendered.flush);
    await rendered.mockInput.pressKey("e\u0301");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("👨‍👩‍👧‍👦e\u0301");
    rendered.renderer.destroy();
    store.setPrompt(null);
  });

  it("Cmd+Left and Cmd+Right jump to the line edges", async () => {
    // macOS: Cmd is `super`, and it means line-edge, not word. Carrying it
    // separately from `option` is what makes the two distinguishable at all.
    const rendered = await liveComposer();
    await typeInto(rendered.mockInput, rendered.flush, "hello world");

    await rendered.mockInput.pressKey("ARROW_LEFT", { super: true } as never);
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("X");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("Xhello world");

    await rendered.mockInput.pressKey("ARROW_RIGHT", { super: true } as never);
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("!");
    await settleKeypress(rendered.flush);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("Xhello world!");
  });

  it("Option+Left moves by word, which must differ from Cmd+Left", async () => {
    const rendered = await liveComposer();
    await typeInto(rendered.mockInput, rendered.flush, "hello world");
    await rendered.mockInput.pressKey("ARROW_LEFT", { meta: true } as never);
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("X");
    await settleKeypress(rendered.flush);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("hello Xworld");
    // The distinction that was broken: a word jump is not a line jump.
    expect(frame).not.toContain("Xhello");
  });

  it("Home, End, Ctrl+A and Ctrl+E reach the line edges too", async () => {
    // These matter because many macOS terminals never forward Cmd at all, so
    // the line-edge motions need a binding that does not depend on it.
    const rendered = await liveComposer();
    await typeInto(rendered.mockInput, rendered.flush, "abc");

    await rendered.mockInput.pressKey("HOME");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("1");
    await settleKeypress(rendered.flush);
    await rendered.mockInput.pressKey("END");
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("9");
    await settleKeypress(rendered.flush);
    expect(rendered.captureCharFrame()).toContain("1abc9");

    await rendered.mockInput.pressKey("a", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("A");
    await settleKeypress(rendered.flush);
    await rendered.mockInput.pressKey("e", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("Z");
    await settleKeypress(rendered.flush);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("A1abc9Z");
  });

  it("does not insert text for an unbound Ctrl chord", async () => {
    // Ctrl chords arrive as control codes — Ctrl+J is "\n", Ctrl+B is
    // "\u0002" — which the one-printable-code-point test excludes without
    // needing to know their names. The composer stays empty and shows its
    // placeholder.
    //
    // Cmd+letter is deliberately not asserted here: outside the kitty keyboard
    // protocol there is no escape sequence that can carry Cmd on a plain
    // letter, so it arrives as the bare character or not at all, and no
    // application can tell it apart from ordinary typing. Cmd is only
    // observable on keys with a CSI form, which is why the Cmd+Arrow test
    // above is the one that can prove that path.
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("j", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await rendered.mockInput.pressKey("b", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frame).toContain("Ask anything");
  });
  it("renders no ANSI escape codes, whatever styling the producer applied", async () => {
    // The presentation service styles strings with chalk before they reach the
    // store. Those escapes are terminal instructions, not characters: rendered
    // into a composited frame they occupy cells and the terminal eats the ones
    // that follow, which is what turned "Reasoning" into "easoning".
    const text = await frame(() => {
      store.printOutput({
        type: "log",
        message: chalk.dim(chalk.italic("Reasoning · 7.2s · ctrl+r to expand")),
        timestamp: new Date(),
      });
      store.printOutput({
        type: "streamContent",
        message: chalk.bold("A styled answer") + " and " + chalk.hex("#00D7FF")("a coloured tail"),
        timestamp: new Date(),
      });
    });

    // Nothing that came out of chalk survives as a literal escape.
    expect(text).not.toContain("\u001b[");
    expect(text).not.toContain("\u001b");
    // And the words themselves are intact — stripping must not eat characters.
    expect(text).toContain("Reasoning · 7.2s · ctrl+r to expand");
    expect(text).toContain("A styled answer and a coloured tail");
  });

  it("keeps streamed deltas clean when the formatter has styled them", async () => {
    const text = await frame(() => {
      store.appendStream("response", chalk.bold("bold start "));
      store.appendStream("response", chalk.dim("dim finish"));
    });
    expect(text).not.toContain("\u001b");
    expect(text).toContain("bold start dim finish");
  });
  it("keeps the indicator visible while the model is reasoning", async () => {
    // Reasoning is the model working with nothing yet to show, which is when an
    // indicator earns its place most. It was excluded from the running set, so
    // the loader vanished the moment thinking began.
    const text = await frame(() => {
      store.setActivity({ phase: "thinking", agentName: "jazz" });
    });
    const rows = text.split("\n").filter((row) => row.length > 0);
    const composerIndex = rows.findIndex((row) => row.includes("Ask anything"));
    expect(composerIndex).toBeGreaterThan(1);
    expect(rows[composerIndex - 1]?.trim()).toBe("");
    const waitingRow = rows[composerIndex - 2] ?? "";
    expect(waitingRow.trim().length).toBeGreaterThan(0);
  });

  it("Ctrl+R expands the last collapsed reasoning", async () => {
    const rendered = await liveComposer();
    // A collapsed reasoning block, exactly as collapseEphemeral records one.
    const regionId = store.openEphemeral("reasoning", "Reasoning", 8);
    store.collapseEphemeral(regionId, {
      line: "Reasoning · 3.2s · ctrl+r to expand",
      fullText: "the full chain of thought",
      durationMs: 3_200,
    });
    store.flushOutputBatchNow();
    await rendered.flush();

    await rendered.mockInput.pressKey("\x12");
    await settleKeypress(rendered.flush, 100);
    store.flushOutputBatchNow();
    await rendered.flush();

    const frameText = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frameText).toContain("the full chain of thought");
  });

  it("Ctrl+R expands reasoning above the answer, not under it", async () => {
    const rendered = await liveComposer();
    const regionId = store.openEphemeral("reasoning", "Reasoning", 8);
    store.collapseEphemeral(regionId, {
      line: "Reasoning · 1.0s · ctrl+r to expand",
      fullText: "thought that belongs first",
      durationMs: 1_000,
    });
    store.printOutput({
      type: "streamContent",
      message: "the spoken answer",
      timestamp: new Date(),
    });
    store.flushOutputBatchNow();
    await rendered.flush();

    await rendered.mockInput.pressKey("r", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await rendered.flush();

    const frameText = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    const thoughtAt = frameText.indexOf("thought that belongs first");
    const answerAt = frameText.indexOf("the spoken answer");
    expect(thoughtAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(-1);
    expect(thoughtAt).toBeLessThan(answerAt);
  });

  it("Ctrl+R expands even while a live reasoning panel is still open", async () => {
    const rendered = await liveComposer();
    const collapsed = store.openEphemeral("reasoning", "Reasoning", 8);
    store.collapseEphemeral(collapsed, {
      line: "Reasoning · 1.0s · ctrl+r to expand",
      fullText: "the earlier thought",
      durationMs: 1_000,
    });
    store.openEphemeral("reasoning", "Reasoning", 8);
    store.flushOutputBatchNow();
    await rendered.flush();

    await rendered.mockInput.pressKey("r", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    await rendered.flush();

    const frameText = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.collapseAllEphemeral();
    store.setPrompt(null);
    expect(frameText).toContain("the earlier thought");
  });

  it("Ctrl+R says so when there is nothing to expand", async () => {
    store.collapseAllEphemeral();
    store.clearOutputs();
    const rendered = await liveComposer();
    await rendered.mockInput.pressKey("r", { ctrl: true });
    await settleKeypress(rendered.flush, 100);
    store.flushOutputBatchNow();
    await rendered.flush();

    const frameText = rendered.captureCharFrame();
    rendered.renderer.destroy();
    store.setPrompt(null);
    expect(frameText).toContain("No collapsed reasoning to expand.");
  });
  /**
   * These drive the *real* producers rather than hand-written payloads.
   *
   * Every regression this file was written to catch got through anyway, and all
   * of them for one reason: the assertions fed shapes production never sends. A
   * receipt test passed a plain string where the activity reducer sends an Ink
   * node carrying no text at all, so the transcript was blank for every settled
   * tool call while the test stayed green. Forcing `chalk.level` was necessary
   * but not sufficient — the payload has to come from the code that builds it.
   */
  describe("driven by the real producers", () => {
    const ESC = String.fromCharCode(27);

    /** A tool that starts and settles, exactly as the reducer records one. */
    function runToolThroughReducer(): void {
      const accumulator = createAccumulator("cassandra");
      for (const event of [
        {
          type: "tool_execution_start" as const,
          toolName: "gmail_search",
          toolCallId: "call-1",
          arguments: { query: "is:unread newer_than:7d" },
        },
        {
          type: "tool_execution_complete" as const,
          toolCallId: "call-1",
          result: "4 flagged of 26",
          summary: "4 flagged of 26",
          durationMs: 1_900,
          success: true,
        },
      ]) {
        const { outputs } = reduceEvent(accumulator, event, ink);
        for (const entry of outputs) store.printOutput(entry);
      }
    }

    it("renders a settled tool call as a receipt", async () => {
      const text = await frame(runToolThroughReducer);
      // The reducer puts the receipt in `meta.toolReceipt` and leaves `message`
      // as an Ink node, so this only passes if the receipt is read before
      // anything consults the entry's text.
      expect(text).toContain("gmail");
      expect(text).toContain("4 flagged of 26");
    });

    it("leaves no escape sequence in a frame built from formatted markdown", async () => {
      const markdown = formatMarkdown(
        "Docs at https://example.com/deep/path and [the guide](https://example.com/guide).",
      );
      // Proves the producer really does style its output, so a clean frame below
      // means the transcript stripped it rather than that there was nothing to
      // strip.
      expect(markdown).toContain(ESC);

      const text = await frame(() => {
        store.printOutput({ type: "streamContent", message: markdown, timestamp: new Date() });
      });
      expect(text).not.toContain(ESC);
      // An OSC 8 hyperlink wraps the label around the target. Stripping only
      // CSI left the sequence painted as cells and the bare URL beside it.
      expect(text).toContain("the guide");
      expect(text).not.toContain("example.com/guide");
    });

    it("shows live reasoning while the region is open", async () => {
      const text = await frame(() => {
        const region = store.openEphemeral("reasoning", "Reasoning", 8);
        store.appendEphemeral(region, "weighing the two calendars");
      });
      expect(text).toContain("weighing the two calendars");
    });

    it("shows a delegated subagent as a lane while it runs", async () => {
      const text = await frame(() => {
        const region = store.openEphemeral("subagent", "travel-scout", 12);
        store.appendEphemeral(region, "checking whether the Basel dates moved");
      });
      expect(text).toContain("travel-scout");
      expect(text).toContain("Basel");
    });

    it("keeps a multi-line entry on separate rows", async () => {
      const text = await frame(() => {
        store.printOutput({
          type: "log",
          message: "first line here\nsecond line here",
          timestamp: new Date(),
        });
      });
      const rows = text.split("\n");
      const first = rows.findIndex((row) => row.includes("first line here"));
      const second = rows.findIndex((row) => row.includes("second line here"));
      expect(first).toBeGreaterThan(-1);
      // A newline is a hard break. Flowed together as whitespace, the second
      // half landed inside the first row after a literal newline and was cut
      // off at it.
      expect(second).toBe(first + 1);
    });
  });
});

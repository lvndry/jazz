/** @jsxImportSource @opentui/react */
/** Exercise viewport ownership through the real shell and OpenTUI input path. */
import type { Renderable } from "@opentui/core";
import { expect, it, spyOn } from "bun:test";
import { useState } from "react";
import { App } from "./App";
import * as clipboard from "./clipboard";
import { sampleIdleView } from "./sample";
import { renderForTest, updateForTest } from "./test-helpers";
import { TranscriptSurfaceRenderable } from "./transcript-surface";
import type { Block, ViewModel } from "./types";

const history: Block = {
  id: "history",
  seq: 1,
  kind: "agent",
  markdown: Array.from({ length: 100 }, (_, i) => `history-${String(i).padStart(3, "0")}`).join(
    "\n\n",
  ),
};
const live: Block = {
  id: "thought",
  seq: 2,
  kind: "reasoning",
  text: "scratch\n".repeat(10),
  collapsed: false,
  live: true,
};
const markers = (frame: string) => frame.match(/history-\d+/g);

function transcriptSurface(node: Renderable): TranscriptSurfaceRenderable | undefined {
  if (node instanceof TranscriptSurfaceRenderable) return node;
  for (const child of node.getChildren()) {
    const surface = transcriptSurface(child);
    if (surface !== undefined) return surface;
  }
  return undefined;
}

it("keeps the same history after live-reason churn and restores each document independently", async () => {
  let change = (_view: ViewModel) => {};
  let submit = (_count: number) => {};
  const main = { ...sampleIdleView(), documentId: "session:main", blocks: [history] };
  const child = {
    ...sampleIdleView(),
    documentId: "session:child:one",
    blocks: [
      {
        ...history,
        id: "child-history",
        markdown: history.markdown.replaceAll("history", "child"),
      },
    ],
  };
  function Harness() {
    const [view, setView] = useState<ViewModel>(main);
    const [submitCount, setSubmitCount] = useState(0);
    submit = setSubmitCount;
    change = setView;
    return (
      <App
        view={view}
        submitCount={submitCount}
        onAction={() => {}}
      />
    );
  }
  const rendered = await renderForTest(<Harness />, { width: 80, height: 16 });
  try {
    await rendered.renderOnce();
    rendered.mockInput.pressKey("\u001b[5~");
    await rendered.flush();
    const before = markers(rendered.captureCharFrame());
    expect(before).toContain("history-091");
    for (let cycle = 0; cycle < 25; cycle++) {
      updateForTest(() => change({ ...main, blocks: [history, live] }));
      await rendered.flush();
      updateForTest(() => change(main));
      await rendered.flush();
    }
    expect(markers(rendered.captureCharFrame())).toEqual(before);
    updateForTest(() => change(child));
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("child-099");
    rendered.mockInput.pressKey("\u001b[5~");
    await rendered.flush();
    const childBefore = rendered.captureCharFrame().match(/child-\d+/g);
    updateForTest(() => change(main));
    await rendered.flush();
    expect(markers(rendered.captureCharFrame())).toEqual(before);
    updateForTest(() => submit(1));
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("history-099");
    rendered.mockInput.pressKey("\u001b[5~");
    await rendered.flush();
    expect(markers(rendered.captureCharFrame())).toEqual(before);
    updateForTest(() => change(child));
    await rendered.flush();
    expect(rendered.captureCharFrame().match(/child-\d+/g)).toEqual(childBefore);
    rendered.mockInput.pressKey("\u001b[5~");
    rendered.mockInput.pressKey("\u001b[F");
    await rendered.flush();
    expect(rendered.captureCharFrame()).toContain("child-099");
  } finally {
    rendered.renderer.destroy();
  }
});

it("routes native selection drag through anchored navigation and cancels it on release and document switch", async () => {
  const scheduled = new Map<ReturnType<typeof setInterval>, () => void>();
  let serial = 100;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: unknown,
    delay?: number,
  ) => {
    const id = ++serial as unknown as ReturnType<typeof setInterval>;
    if (delay === 50) scheduled.set(id, callback as () => void);
    return id;
  }) as typeof globalThis.setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
    scheduled.delete(id as ReturnType<typeof setInterval>);
  });
  const copy = spyOn(clipboard, "copyText").mockResolvedValue(true);
  let change = (_view: ViewModel) => {};
  let following = true;
  const main = { ...sampleIdleView(), documentId: "drag:main", blocks: [history] };
  function Harness() {
    const [view, setView] = useState<ViewModel>(main);
    change = setView;
    return (
      <App
        view={view}
        onAction={() => {}}
        onWatchingLiveEdgeChange={(live) => {
          following = live;
        }}
      />
    );
  }
  const rendered = await renderForTest(<Harness />, { width: 80, height: 16 });
  try {
    await rendered.flush();
    const before = markers(rendered.captureCharFrame());
    const surface = transcriptSurface(rendered.renderer.root);
    expect(surface).toBeDefined();
    await rendered.mockMouse.pressDown(25, 7);
    await rendered.mockMouse.moveTo(25, 2);
    await rendered.flush();
    expect(following).toBe(false);
    expect(surface?.live).toBe(false);
    expect(surface?.scrollTop).toBe(0);
    expect(scheduled.size).toBe(1);
    updateForTest(() => {
      for (const tick of scheduled.values()) tick();
    });
    await rendered.flush();
    expect(markers(rendered.captureCharFrame())).not.toEqual(before);
    await rendered.mockMouse.release(25, 2);
    expect(scheduled.size).toBe(0);
    await rendered.mockMouse.scroll(25, 6, "up");
    await rendered.flush();
    expect(surface?.scrollTop).toBe(0);
    expect(surface?.live).toBe(false);
    await rendered.mockMouse.pressDown(25, 7);
    await rendered.mockMouse.moveTo(25, 2);
    expect(scheduled.size).toBe(1);
    updateForTest(() => change({ ...main, documentId: "drag:child" }));
    expect(scheduled.size).toBe(0);
    await rendered.flush();
    expect(following).toBe(true);
    expect(rendered.captureCharFrame()).toContain("history-099");
  } finally {
    rendered.renderer.destroy();
    expect(scheduled.size).toBe(0);
    copy.mockRestore();
    interval.mockRestore();
    clear.mockRestore();
  }
});

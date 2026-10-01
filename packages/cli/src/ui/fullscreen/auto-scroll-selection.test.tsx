/** @jsxImportSource @opentui/react */
/** Drag timers must respect document/overlay ownership and release all work on unmount. */
import type { MouseEvent } from "@opentui/core";
import { expect, it, spyOn } from "bun:test";
import { useState } from "react";
import { useAutoScrollOnDrag } from "./auto-scroll-selection";
import { renderForTest, updateForTest } from "./test-helpers";

it("cancels edge scrolling on drag end, occlusion, document switch and unmount", async () => {
  const scheduled = new Map<ReturnType<typeof setInterval>, () => void>();
  let serial = 100;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: unknown) => {
    const id = ++serial as unknown as ReturnType<typeof setInterval>;
    scheduled.set(id, callback as () => void);
    return id;
  }) as typeof globalThis.setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
    scheduled.delete(id as ReturnType<typeof setInterval>);
  });
  const calls: number[] = [];
  const navigate = (delta: number) => {
    calls.push(delta);
  };
  let change = (_value: { enabled: boolean; documentId: string }) => {};
  let handlers: ReturnType<typeof useAutoScrollOnDrag> | undefined;
  function Harness() {
    const [value, setValue] = useState({ enabled: true, documentId: "main" });
    change = setValue;
    handlers = useAutoScrollOnDrag(navigate, 2, 10, value.enabled, value.documentId);
    return <box />;
  }
  const rendered = await renderForTest(<Harness />, { width: 80, height: 16 });
  try {
    await rendered.renderOnce();
    const activeTimers = () => scheduled.size;
    const drag = () => handlers?.onMouseDrag({ y: 0 } as MouseEvent);
    drag();
    expect(calls).toEqual([-3]);
    expect(activeTimers()).toBe(1);
    for (const tick of scheduled.values()) tick();
    expect(calls).toEqual([-3, -3]);
    handlers?.onMouseDragEnd();
    expect(activeTimers()).toBe(0);
    drag();
    updateForTest(() => change({ enabled: false, documentId: "main" }));
    expect(activeTimers()).toBe(0);
    drag();
    expect(activeTimers()).toBe(0);
    updateForTest(() => change({ enabled: true, documentId: "main" }));
    drag();
    updateForTest(() => change({ enabled: true, documentId: "child" }));
    expect(activeTimers()).toBe(0);
    drag();
    rendered.renderer.destroy();
    expect(activeTimers()).toBe(0);
  } finally {
    if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
    interval.mockRestore();
    clear.mockRestore();
  }
});

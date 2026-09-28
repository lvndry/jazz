/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import type React from "react";
import { App } from "./App";
import { sampleView } from "./sample";
import { renderForTest } from "./test-helpers";
import { useStreamReveal } from "./use-stream-reveal";

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

function Revealed({ target, paced }: { target: string; paced: boolean }): React.ReactNode {
  const shown = useStreamReveal(target, paced, () => 0);
  return <text>{`shown:${String(shown.length)}`}</text>;
}

describe("pacing follows the reader", () => {
  it("reveals a backlog gradually while the reader watches the live edge", async () => {
    const target = "word ".repeat(200);
    const rendered = await renderForTest(
      <Revealed
        target={target}
        paced
      />,
      { width: 40, height: 3 },
    );
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain("shown:0");
    rendered.renderer.destroy();
  });

  it("shows the whole text at once while the reader is away from it", async () => {
    const target = "word ".repeat(200);
    const rendered = await renderForTest(
      <Revealed
        target={target}
        paced={false}
      />,
      {
        width: 40,
        height: 3,
      },
    );
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain(`shown:${String(target.length)}`);
    rendered.renderer.destroy();
  });

  it("reports leaving and returning to the live edge", async () => {
    const reports: boolean[] = [];
    const rendered = await renderForTest(
      <App
        view={sampleView()}
        onAction={() => undefined}
        onWatchingLiveEdgeChange={(watching) => reports.push(watching)}
      />,
      { width: 100, height: 20 },
    );
    await rendered.renderOnce();
    rendered.mockInput.pressKey(PAGE_UP);
    await rendered.flush();
    rendered.mockInput.pressKey(PAGE_DOWN);
    rendered.mockInput.pressKey(PAGE_DOWN);
    rendered.mockInput.pressKey(PAGE_DOWN);
    await rendered.flush();
    rendered.renderer.destroy();
    expect(reports).toEqual([true, false, true]);
  });
});

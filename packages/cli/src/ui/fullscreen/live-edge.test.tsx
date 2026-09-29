/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import { App } from "./App";
import { sampleView } from "./sample";
import { renderForTest } from "./test-helpers";

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

describe("the reader's place", () => {
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

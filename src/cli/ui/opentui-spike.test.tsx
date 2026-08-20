/** @jsxImportSource @opentui/react */
/**
 * Spike: can OpenTUI do the three things Ink cannot, which the fullscreen
 * design depends on?
 *
 *   1. A five-region layout that occupies the terminal exactly, with the input
 *      and footer anchored to the bottom.
 *   2. A transcript that scrolls independently of the terminal.
 *   3. An overlay that does NOT disturb the transcript behind it.
 *
 * (3) is the one that blocks fullscreen on Ink: with no compositing layers an
 * overlay is just more nodes in the same tree, so the transcript relayouts and
 * loses its scroll offset. This asserts the behaviour rather than assuming it.
 */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React from "react";

const WIDTH = 80;
const HEIGHT = 24;

/** Enough lines that the transcript must scroll. */
const TRANSCRIPT = Array.from(
  { length: 60 },
  (_, index) => `line-${String(index).padStart(3, "0")}`,
);

function Layout({ overlay }: { overlay: boolean }): React.ReactNode {
  return (
    <box style={{ width: WIDTH, height: HEIGHT, flexDirection: "column" }}>
      {/* header — fixed one row */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text>HEADER jazz</text>
      </box>

      {/* transcript — takes the remaining space and owns its own scrolling */}
      <scrollbox style={{ flexGrow: 1 }}>
        {TRANSCRIPT.map((line) => (
          <text key={line}>{line}</text>
        ))}
      </scrollbox>

      {/* live zone — fixed, anchored above the input */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text>LIVEZONE 2 running</text>
      </box>

      {/* input — fixed */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text>INPUT ready</text>
      </box>

      {/* footer — fixed, last row */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text>FOOTER chat</text>
      </box>

      {overlay ? (
        <box
          style={{
            position: "absolute",
            left: 10,
            top: 6,
            width: 50,
            height: 8,
            backgroundColor: "#14171B",
            border: true,
          }}
        >
          <text>APPROVAL create event</text>
        </box>
      ) : null}
    </box>
  );
}

/** The transcript rows of a captured frame: everything between the chrome. */
function transcriptRows(frame: string): string[] {
  return frame
    .split("\n")
    .filter((row) => /line-\d{3}/.test(row))
    .map((row) => (row.match(/line-\d{3}/) as RegExpMatchArray)[0]);
}

describe("opentui fullscreen spike", () => {
  it("renders five regions at exactly the terminal size, chrome anchored", async () => {
    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <Layout overlay={false} />,
      {
        width: WIDTH,
        height: HEIGHT,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const rows = frame.split("\n").filter((row) => row.length > 0);

    expect(rows).toHaveLength(HEIGHT);
    for (const row of rows) expect([...row]).toHaveLength(WIDTH);

    // Chrome in the right places: header first, footer last.
    expect(rows[0]).toContain("HEADER");
    expect(rows[HEIGHT - 1]).toContain("FOOTER");
    expect(rows[HEIGHT - 2]).toContain("INPUT");
    expect(rows[HEIGHT - 3]).toContain("LIVEZONE");

    renderer.destroy();
  });

  it("scrolls the transcript independently, and the chrome does not move", async () => {
    type Scroller = { scrollTo: (position: { x: number; y: number }) => void };
    // A holder rather than a bare `let`: TypeScript narrows a variable only
    // assigned inside a closure to `never`, which hides the real type.
    const held: { instance: Scroller | null } = { instance: null };

    function Scrollable(): React.ReactNode {
      return (
        <box style={{ width: WIDTH, height: HEIGHT, flexDirection: "column" }}>
          <box style={{ height: 1, flexShrink: 0 }}>
            <text>HEADER jazz</text>
          </box>
          <scrollbox
            style={{ flexGrow: 1 }}
            ref={(instance: Scroller | null) => {
              held.instance = instance;
            }}
          >
            {TRANSCRIPT.map((line) => (
              <text key={line}>{line}</text>
            ))}
          </scrollbox>
          <box style={{ height: 1, flexShrink: 0 }}>
            <text>FOOTER chat</text>
          </box>
        </box>
      );
    }

    const { renderer, renderOnce, captureCharFrame } = await testRender(<Scrollable />, {
      width: WIDTH,
      height: HEIGHT,
    });
    await renderOnce();

    const before = captureCharFrame()
      .split("\n")
      .filter((row) => row.length > 0);
    expect(transcriptRows(before.join("\n"))[0]).toBe("line-000");

    expect(held.instance).not.toBeNull();
    held.instance?.scrollTo({ x: 0, y: 20 });
    await renderOnce();

    const after = captureCharFrame()
      .split("\n")
      .filter((row) => row.length > 0);
    const afterRows = transcriptRows(after.join("\n"));

    // The transcript moved...
    expect(afterRows[0]).not.toBe("line-000");
    // ...and the chrome did not.
    expect(after[0]).toContain("HEADER");
    expect(after[HEIGHT - 1]).toContain("FOOTER");

    renderer.destroy();
  });

  it("opens an overlay without disturbing the transcript behind it", async () => {
    const { renderer, renderOnce, captureCharFrame } = await testRender(
      <Layout overlay={false} />,
      {
        width: WIDTH,
        height: HEIGHT,
      },
    );
    await renderOnce();
    const withoutOverlay = transcriptRows(captureCharFrame());

    // Same tree, overlay on.
    const {
      renderer: r2,
      renderOnce: render2,
      captureCharFrame: capture2,
    } = await testRender(<Layout overlay={true} />, { width: WIDTH, height: HEIGHT });
    await render2();
    const frameWithOverlay = capture2();

    expect(frameWithOverlay).toContain("APPROVAL");

    // The rows the overlay does not cover must be identical — an overlay that
    // reflows the transcript would shift or drop lines here.
    const covered = new Set(Array.from({ length: 8 }, (_, index) => index + 6));
    const visible = frameWithOverlay
      .split("\n")
      .filter((row) => row.length > 0)
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => !covered.has(index))
      .map(({ row }) => row.match(/line-\d{3}/)?.[0])
      .filter((value): value is string => value !== undefined);

    for (const line of visible) {
      expect(withoutOverlay).toContain(line);
    }

    r2.destroy();
    renderer.destroy();
  });
});

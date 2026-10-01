/** @jsxImportSource @opentui/react */

/**
 * Compare real native ANSI frames with an independent VT grid through transcript
 * mutations. Synthetic receipts avoid private session fixtures. The deliberate
 * corruption case proves buffer-only assertions cannot satisfy this oracle.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createLayoutFixture } from "./layout-fixture";
import { repaintAfterResize } from "../mount";
import { Transcript } from "../Transcript";
import type { Block } from "../types";
import {
  createTerminalOracle,
  createVtObserver,
  nativeGrid,
  type TerminalGrid,
} from "./terminal-oracle";

const { rows: layoutRows } = createLayoutFixture();

function text(grid: TerminalGrid): string {
  return grid.cells.map((row) => row.map((cell) => cell.chars).join("")).join("\n");
}

function scene(blocks: readonly Block[], width: number, height: number): ReactNode {
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
    >
      <Transcript
        rows={layoutRows(blocks, { width, height }).slice(-height)}
        viewport={{ width, height }}
        focus="input"
      />
    </box>
  );
}

describe("native terminal oracle", () => {
  test("parses bytes independently and preserves blank cells and wide continuations", async () => {
    const observer = createVtObserver(8, 3);
    try {
      const borrowed = new TextEncoder().encode("\x1b[?1049h\x1b[2J\x1b[Habc\x1b[2;1H界");
      observer.accept(borrowed);
      borrowed.fill(0);
      expect(() => observer.captureGrid()).toThrow("Drain");
      const parsed = observer.drain();
      expect(() => observer.captureGrid()).toThrow("Drain");
      await parsed;
      const grid = observer.captureGrid();
      expect(grid.cells[0]?.[0]).toEqual({ chars: "a", width: 1 });
      expect(grid.cells[1]?.[0]).toEqual({ chars: "界", width: 2 });
      expect(grid.cells[1]?.[1]).toEqual({ chars: "", width: 0 });
      expect(grid.cells[2]?.[7]).toEqual({ chars: " ", width: 1 });
      expect(observer.outputBytes()).toBeGreaterThan(0);
    } finally {
      observer.dispose();
      observer.dispose();
    }
  });

  test("receipt bursts, shrinking content and settled answers reach the actual terminal grid", async () => {
    const oracle = await createTerminalOracle({ width: 80, height: 16 });
    try {
      const blocks: Block[] = [
        { id: "user", seq: 0, kind: "user", text: "Inspect the synthetic jobs" },
      ];
      oracle.render(scene(blocks, 80, 16));
      await oracle.flush();
      expect(oracle.compareGrid()).toEqual([]);

      for (let index = 0; index < 36; index++) {
        blocks.push({
          id: `receipt:${String(index)}`,
          seq: index + 1,
          kind: "tool",
          app: "files",
          summary: `job ${String(index)} complete`,
          status: "ok",
          durationMs: index + 1,
        });
        oracle.render(scene([...blocks], 80, 16));
        await oracle.flush();
        expect(oracle.compareGrid()).toEqual([]);
      }
      const answer: Block = {
        id: "answer",
        seq: 40,
        kind: "agent",
        markdown: "Final answer visible.\n\n" + "A long synthetic observation. ".repeat(20),
        streaming: true,
      };
      oracle.render(scene([...blocks, answer], 80, 16));
      await oracle.flush();
      expect(oracle.compareGrid()).toEqual([]);
      oracle.render(
        scene([{ ...answer, markdown: "Settled answer visible.", streaming: false }], 80, 16),
      );
      const final = await oracle.flush();
      expect(oracle.compareGrid()).toEqual([]);
      expect(text(final)).toContain("Settled answer visible.");
      expect(text(final)).not.toContain("synthetic observation");
      expect(final.cells[0]?.every((cell) => cell.chars === " ")).toBe(true);
    } finally {
      oracle.dispose();
    }
  });

  test("native Unicode output agrees on glyphs and occupied cells", async () => {
    const oracle = await createTerminalOracle({ width: 32, height: 10 });
    try {
      oracle.render(
        <text
          width={32}
          height={1}
        >
          Jazz 界 café
        </text>,
      );
      await oracle.flush();
      expect(oracle.compareGrid()).toEqual([]);
      expect(oracle.captureGrid().cells[0]?.[5]).toEqual({ chars: "界", width: 2 });
      expect(oracle.captureGrid().cells[0]?.[6]).toEqual({ chars: "", width: 0 });
    } finally {
      oracle.dispose();
    }
  });

  test("key and wheel bytes traverse native input parsing without process stdin", async () => {
    const oracle = await createTerminalOracle({ width: 32, height: 10 });
    const keys: string[] = [];
    const wheels: string[] = [];
    const onKey = (event: { readonly name: string }): void => {
      keys.push(event.name);
    };
    oracle.renderer.keyInput.on("keypress", onKey);
    try {
      oracle.render(
        <box
          width={32}
          height={10}
          onMouseScroll={(event) => wheels.push(event.scroll?.direction ?? "none")}
        >
          <text>Input surface</text>
        </box>,
      );
      await oracle.flush();
      oracle.input("a\x1b[A\x1b[<65;4;3M");
      await oracle.flush();
      expect(keys).toEqual(["a", "up"]);
      expect(wheels).toEqual(["down"]);
      expect(oracle.compareGrid()).toEqual([]);
    } finally {
      oracle.renderer.keyInput.off("keypress", onKey);
      oracle.dispose();
    }
  });

  test("detects physical corruption while the native buffer stays correct, then verifies full repaint", async () => {
    const oracle = await createTerminalOracle({ width: 32, height: 10 });
    try {
      oracle.render(
        <text
          width={32}
          height={1}
        >
          Intended answer
        </text>,
      );
      await oracle.flush();
      const intended = nativeGrid(oracle.renderer.currentRenderBuffer);
      expect(oracle.compareGrid()).toEqual([]);
      await oracle.writeTerminal("\x1b[1;1HX\x1b[10;32HY");
      expect(nativeGrid(oracle.renderer.currentRenderBuffer)).toEqual(intended);
      expect(oracle.compareGrid()).toEqual([
        { column: 0, row: 0, field: "chars" },
        { column: 31, row: 9, field: "chars" },
      ]);
      oracle.renderer.requestRender();
      await oracle.flush();
      expect(oracle.compareGrid()).toHaveLength(2);
      const internals = oracle.renderer as unknown as { forceFullRepaintRequested: boolean };
      internals.forceFullRepaintRequested = true;
      oracle.renderer.requestRender();
      await oracle.flush();
      expect(oracle.compareGrid()).toEqual([]);
    } finally {
      oracle.dispose();
    }
  });

  test("resize and full repaint preserve the terminal grid including cleared margins", async () => {
    const oracle = await createTerminalOracle({ width: 80, height: 16 });
    const stopRepaint = repaintAfterResize(oracle.renderer);
    try {
      const blocks: readonly Block[] = [
        { id: "user", seq: 0, kind: "user", text: "Resize this viewport" },
        { id: "answer", seq: 1, kind: "agent", markdown: "Final wide answer. ".repeat(45) },
      ];
      for (const [width, height] of [
        [80, 16],
        [103, 34],
        [160, 40],
        [32, 10],
        [80, 16],
      ] as const) {
        await oracle.resize(width, height);
        oracle.render(scene(blocks, width, height));
        await oracle.flush();
        expect(oracle.compareGrid()).toEqual([]);
      }
    } finally {
      stopRepaint();
      oracle.dispose();
    }
  });
});

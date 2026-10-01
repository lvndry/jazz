/**
 * Exercise the production OpenTUI native writer without owning the user's TTY.
 *
 * createTerminalOracle mounts React on real custom-stream OpenTUI output. flush
 * waits for native output before feeding those bytes to an independent xterm VT
 * parser. compareGrid compares every glyph, width and blank cell against the
 * intended native buffer; mismatch reports contain coordinates, never content.
 *
 * createVtObserver is also usable by benchmarks: accept only copies bytes and
 * drain parses them later, outside the timed native paint sample. Call drain
 * before reading the grid or resizing, and dispose each instance after use.
 * This checks ANSI semantics, not a host terminal's fonts or PTY transport.
 */

import { PassThrough, Writable } from "node:stream";
import { createCliRenderer, type CliRenderer, type OptimizedBuffer } from "@opentui/core";
import { createRoot, flushSync } from "@opentui/react";
import { Terminal } from "@xterm/headless";
import { createElement, useSyncExternalStore, type ReactNode } from "react";

export interface GridCell {
  readonly chars: string;
  readonly width: number;
}

export interface TerminalGrid {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly (readonly GridCell[])[];
}

export interface GridMismatch {
  readonly column: number;
  readonly row: number;
  readonly field: "chars" | "width" | "geometry";
}

export interface VtObserver {
  readonly accept: (bytes: Uint8Array) => void;
  readonly drain: () => Promise<void>;
  readonly resize: (columns: number, rows: number) => void;
  readonly captureGrid: () => TerminalGrid;
  readonly outputBytes: () => number;
  readonly dispose: () => void;
}

/** Copy borrowed native feed memory now; interpret it only at an explicit observation boundary. */
export function createVtObserver(columns: number, rows: number): VtObserver {
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
  let pending: Uint8Array[] = [];
  let bytesAccepted = 0;
  let disposed = false;
  let parsing = false;
  return {
    accept(bytes) {
      if (disposed) throw new Error("Terminal observer is disposed");
      bytesAccepted += bytes.byteLength;
      pending.push(Uint8Array.from(bytes));
    },
    async drain() {
      if (disposed) throw new Error("Terminal observer is disposed");
      if (parsing) throw new Error("Terminal output is already being drained");
      parsing = true;
      try {
        while (pending.length > 0) {
          const chunks = pending;
          pending = [];
          for (const chunk of chunks) {
            await new Promise<void>((resolve) => terminal.write(chunk, resolve));
          }
        }
      } finally {
        parsing = false;
      }
    },
    resize(nextColumns, nextRows) {
      if (disposed) throw new Error("Terminal observer is disposed");
      if (parsing || pending.length > 0) throw new Error("Drain terminal output before resizing");
      terminal.resize(nextColumns, nextRows);
    },
    captureGrid() {
      if (disposed) throw new Error("Terminal observer is disposed");
      if (parsing || pending.length > 0)
        throw new Error("Drain terminal output before capturing the grid");
      const buffer = terminal.buffer.active;
      const cells = Array.from({ length: terminal.rows }, (_, row) => {
        const line = buffer.getLine(buffer.baseY + row);
        return Array.from({ length: terminal.cols }, (_, column): GridCell => {
          const cell = line?.getCell(column);
          const width = cell?.getWidth() ?? 1;
          return { chars: cell?.getChars() || (width === 0 ? "" : " "), width };
        });
      });
      return { columns: terminal.cols, rows: terminal.rows, cells };
    },
    outputBytes: () => bytesAccepted,
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = [];
      terminal.dispose();
    },
  };
}

const decoder = new TextDecoder();
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const CONTINUATION_MASK = 0xc0000000;

/** Resolve native glyphs while preserving continuation cells rather than trimming blank margins. */
export function nativeGrid(buffer: OptimizedBuffer): TerminalGrid {
  const lines = decoder.decode(buffer.getRealCharBytes(true)).split("\n");
  const raw = buffer.buffers.char;
  const continuation = (index: number): boolean =>
    ((raw[index] ?? 0) & CONTINUATION_MASK) >>> 0 === CONTINUATION_MASK;
  const cells = Array.from({ length: buffer.height }, (_, row) => {
    const segments = Array.from(graphemes.segment(lines[row] ?? ""), (item) => item.segment);
    let segment = 0;
    return Array.from({ length: buffer.width }, (_, column): GridCell => {
      const index = row * buffer.width + column;
      if (continuation(index)) return { chars: "", width: 0 };
      let width = 1;
      while (column + width < buffer.width && continuation(index + width)) width++;
      return { chars: segments[segment++] ?? " ", width };
    });
  });
  return { columns: buffer.width, rows: buffer.height, cells };
}

/** Return only differing coordinates; diagnostics must never echo session text. */
export function compareTerminalGrids(
  expected: TerminalGrid,
  actual: TerminalGrid,
): readonly GridMismatch[] {
  if (expected.columns !== actual.columns || expected.rows !== actual.rows) {
    return [{ column: 0, row: 0, field: "geometry" }];
  }
  const mismatches: GridMismatch[] = [];
  for (let row = 0; row < expected.rows; row++) {
    for (let column = 0; column < expected.columns; column++) {
      const intended = expected.cells[row]?.[column];
      const observed = actual.cells[row]?.[column];
      if (intended?.chars !== observed?.chars) mismatches.push({ column, row, field: "chars" });
      if (intended?.width !== observed?.width) mismatches.push({ column, row, field: "width" });
    }
  }
  return mismatches;
}

/** Fake TTY dimensions and raw input belong to this instance, never process stdio. */
class OracleOutput extends Writable {
  readonly isTTY = true;
  constructor(
    public columns: number,
    public rows: number,
    private readonly observer: VtObserver,
  ) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.observer.accept(chunk);
    done();
  }

  getColorDepth(): number {
    return 24;
  }
}

export interface TerminalOracle {
  readonly renderer: CliRenderer;
  readonly render: (node: ReactNode) => void;
  readonly flush: () => Promise<TerminalGrid>;
  readonly resize: (columns: number, rows: number) => Promise<TerminalGrid>;
  readonly captureGrid: () => TerminalGrid;
  readonly compareGrid: () => readonly GridMismatch[];
  readonly writeTerminal: (bytes: string) => Promise<void>;
  readonly input: (bytes: string) => void;
  readonly dispose: () => void;
}

/** Create a demand-driven alternate-screen renderer using the actual native feed output path. */
export async function createTerminalOracle(options: {
  readonly width: number;
  readonly height: number;
}): Promise<TerminalOracle> {
  const observer = createVtObserver(options.width, options.height);
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
    ref: () => input,
    unref: () => input,
  });
  const output = new OracleOutput(options.width, options.height, observer);
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      width: options.width,
      height: options.height,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      consoleMode: "disabled",
      useThread: false,
      useMouse: true,
      useKittyKeyboard: null,
      forwardEnvKeys: [],
      clearOnShutdown: false,
    });
  } catch (error) {
    input.destroy();
    output.destroy();
    observer.dispose();
    throw error;
  }
  const root = createRoot(renderer);
  let node: ReactNode = null;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const snapshot = (): ReactNode => node;
  function Scene(): ReactNode {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
  }
  flushSync(() => root.render(createElement(Scene)));
  let disposed = false;
  const flush = async (): Promise<TerminalGrid> => {
    await renderer.idle();
    await observer.drain();
    return observer.captureGrid();
  };
  return {
    renderer,
    render: (next) =>
      flushSync(() => {
        node = next;
        for (const listener of listeners) listener();
      }),
    flush,
    async resize(columns, rows) {
      await flush();
      observer.resize(columns, rows);
      output.columns = columns;
      output.rows = rows;
      renderer.resize(columns, rows);
      return flush();
    },
    captureGrid: observer.captureGrid,
    compareGrid: () =>
      compareTerminalGrids(nativeGrid(renderer.currentRenderBuffer), observer.captureGrid()),
    async writeTerminal(bytes) {
      observer.accept(new TextEncoder().encode(bytes));
      await observer.drain();
    },
    input: (bytes) => input.write(bytes),
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        flushSync(() => root.unmount());
      } finally {
        renderer.destroy();
        input.destroy();
        output.destroy();
        observer.dispose();
      }
    },
  };
}

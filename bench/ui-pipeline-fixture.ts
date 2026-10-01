/**
 * Drives the production store and React trees into terminal output for UI benchmarks.
 * OpenTUI uses its native ANSI writer and React reconciler; Ink uses its interactive
 * reconciler/Yoga/stdout writer. Both write to an in-memory terminal sink, including commit
 * and ANSI output generation. OpenTUI verifies markers in its current native buffer
 * after a frame/output tick: concatenating ANSI diffs cannot reconstruct a screen.
 * Neither measures a terminal emulator or GPU presentation.
 * Mutations are serialized because both trees subscribe to the process-wide UIStore.
 */
import { PassThrough, Writable } from "node:stream";
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import { render } from "ink";
import React from "react";
import { PROSE_PARAGRAPH } from "./corpus";
import { createInputService } from "../packages/cli/src/services/input-service";
import {
  TerminalCapabilityServiceLive,
  TerminalCapabilityServiceTag,
} from "../packages/cli/src/services/terminal-service";
import { App as InkApp } from "../packages/cli/src/ui/App";
import { InputServiceContext } from "../packages/cli/src/ui/contexts/InputContext";
import { TerminalDimensionsProvider } from "../packages/cli/src/ui/contexts/TerminalDimensionsContext";
import { FullscreenBridge } from "../packages/cli/src/ui/fullscreen/bridge";
import { updateForTest } from "../packages/cli/src/ui/fullscreen/test-helpers";
import { store } from "../packages/cli/src/ui/store";
import { REVEAL_FRAME_MS } from "../packages/cli/src/ui/text/stream-pacer";
import { stripAnsiCodes } from "../packages/cli/src/utils/string-utils";

export type RendererKind = "ink" | "opentui";

export interface Pipeline {
  mutate(change: () => void): void;
  paint(): Promise<string>;
  resize(width: number, height: number): Promise<string>;
  outputBytes(): number;
  close(): Promise<void>;
}

/** Validated limits prevent accidental empty samples and unbounded CI runs. */
export function positiveLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resetPipelineStore(): void {
  store.setStreamPacing(false);
  store.setReaderFollowing(true);
  store.clearOutputs();
  store.setActivity({ phase: "idle" });
  store.setActiveMenu(null);
  store.setApprovalRequest(null);
  store.setChatBusy(false);
  store.setCurrentConversation(null);
  store.clearQueue();
  store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
  store.resetRunStats({ model: "bench-local" });
}

/** Seed realistic settled turns; fixture construction stays outside frame timing. */
export function seedHistory(turns: number): void {
  for (let turn = 0; turn < turns; turn++) {
    store.printOutput({ type: "user", message: `question ${turn}`, timestamp: new Date(0) });
    store.printOutput({
      type: "streamContent",
      message: { kind: "agent", markdown: `${PROSE_PARAGRAPH}turn ${turn}` },
      timestamp: new Date(0),
    });
  }
  store.flushOutputBatchNow();
}

class TerminalSink extends Writable {
  isTTY = true;
  columns = 120;
  rows = 40;
  bytes = 0;
  text = "";
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.bytes += chunk.byteLength;
    this.text = (this.text + chunk.toString()).slice(-200_000);
    done();
  }
}

/** Custom streams keep native ANSI output observable without acquiring the user's TTY. */
function terminalInput(): PassThrough & { isTTY: boolean; setRawMode: () => PassThrough } {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
    ref: () => input,
    unref: () => input,
  });
  return input;
}

/** Mount exactly one renderer; callers must close it before mounting the next. */
export async function mountPipeline(kind: RendererKind): Promise<Pipeline> {
  resetPipelineStore();
  if (kind === "opentui") {
    const output = new TerminalSink();
    const input = terminalInput();
    const renderer = await createCliRenderer({
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      width: 120,
      height: 40,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      maxFps: Math.round(1000 / REVEAL_FRAME_MS),
      useMouse: true,
      clearOnShutdown: false,
      consoleMode: "disabled",
    });
    const decoder = new TextDecoder();
    const root = createRoot(renderer);
    const close = async (): Promise<void> => {
      store.setStreamPacing(false);
      try {
        updateForTest(() => root.unmount());
      } finally {
        renderer.destroy();
        input.destroy();
        output.destroy();
        resetPipelineStore();
      }
    };
    const paint = async (): Promise<string> => {
      await new Promise<void>((resolve, reject) => {
        const onFrame = (): void => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          renderer.off(CliRenderEvents.FRAME, onFrame);
          reject(new Error("OpenTUI native renderer produced no frame"));
        }, 5_000);
        renderer.once(CliRenderEvents.FRAME, onFrame);
        renderer.requestRender();
      });
      await Bun.sleep(0);
      return decoder.decode(renderer.currentRenderBuffer.getRealCharBytes(true));
    };
    try {
      updateForTest(() => root.render(React.createElement(FullscreenBridge)));
      const mountedAt = performance.now();
      while (!stripAnsiCodes(output.text).includes("bench-local")) {
        await paint();
        if (performance.now() - mountedAt > 5_000)
          throw new Error("OpenTUI native terminal writer never painted the model footer");
        await Bun.sleep(2);
      }
    } catch (error) {
      await close();
      throw error;
    }
    return {
      mutate: updateForTest,
      paint,
      async resize(width, height) {
        output.text = "";
        output.columns = width;
        output.rows = height;
        updateForTest(() => renderer.resize(width, height));
        if (renderer.width !== width || renderer.height !== height)
          throw new Error(`OpenTUI resize failed: ${renderer.width}x${renderer.height}`);
        return paint();
      },
      outputBytes: () => output.bytes,
      close,
    };
  }

  const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const savedRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "columns", {
    value: 120,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });
  const output = new TerminalSink();
  const input = terminalInput();
  const service = Effect.runSync(
    Effect.gen(function* () {
      const terminal = yield* TerminalCapabilityServiceTag;
      return createInputService(yield* terminal.capabilities);
    }).pipe(Effect.provide(TerminalCapabilityServiceLive)),
  );
  const tree = React.createElement(
    TerminalDimensionsProvider,
    null,
    React.createElement(
      InputServiceContext.Provider,
      { value: service },
      React.createElement(InkApp),
    ),
  );
  const instance = render(tree, {
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    stdin: input as unknown as NodeJS.ReadStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const paint = async (): Promise<string> => {
    await Bun.sleep(0);
    await instance.waitUntilRenderFlush();
    return stripAnsiCodes(output.text);
  };
  await paint();
  return {
    mutate: (change) => change(),
    paint,
    async resize(width, height) {
      output.text = "";
      output.columns = width;
      output.rows = height;
      process.stdout.columns = width;
      process.stdout.rows = height;
      output.emit("resize");
      process.stdout.emit("resize");
      await Bun.sleep(160);
      return paint();
    },
    outputBytes: () => output.bytes,
    async close() {
      store.setStreamPacing(false);
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      input.destroy();
      output.destroy();
      if (savedColumns) Object.defineProperty(process.stdout, "columns", savedColumns);
      else delete (process.stdout as Partial<NodeJS.WriteStream>).columns;
      if (savedRows) Object.defineProperty(process.stdout, "rows", savedRows);
      else delete (process.stdout as Partial<NodeJS.WriteStream>).rows;
      resetPipelineStore();
    },
  };
}

/** A sample fails if the requested output never appears, rather than timing a blank frame. */
export async function awaitPaint(
  pipeline: Pipeline,
  marker: string,
  deadlineMs = 5_000,
): Promise<string> {
  const start = performance.now();
  for (;;) {
    const frame = await pipeline.paint();
    if (frame.includes(marker)) return frame;
    if (performance.now() - start > deadlineMs) throw new Error(`Terminal never painted ${marker}`);
    await Bun.sleep(2);
  }
}

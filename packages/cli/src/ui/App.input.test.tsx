/** Drives double Escape through the actual classic Ink root, without a mocked runner or helper. */
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import { render } from "ink";
import App from "./App";
import { InputProvider } from "./contexts/InputContext";
import { store } from "./store";

test("classic double Escape interrupts the run and marks follow-ups for immediate drain", async () => {
  let hintReady: () => void = () => undefined;
  const hint = new Promise<void>((resolve) => {
    hintReady = resolve;
  });
  let interrupted: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(enabled: boolean) {
      this.isRaw = enabled;
      return this;
    },
    ref() {
      return this;
    },
    unref() {
      return this;
    },
  });
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
        if (chunk.toString().includes("Press Esc again")) {
          hintReady();
        }
        done();
      },
    }),
    { isTTY: true, columns: 100, rows: 30 },
  );
  let interrupts = 0;
  store.clearQueue();
  store.consumeFlushQueue();
  store.clearOutputs();
  store.setInterruptHandler(() => {
    interrupts++;
    interrupted();
  });
  store.appendToQueue("then summarize", "followup");
  const app = render(
    <InputProvider>
      <App />
    </InputProvider>,
    {
      stdin: input,
      stdout: output,
      stderr: output,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  try {
    await app.waitUntilRenderFlush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("\x1b");
    await hint;
    expect(interrupts).toBe(0);
    input.write("\x1b");
    await stopped;
    expect(interrupts).toBe(1);
    expect(store.consumeFlushQueue()).toBe(true);
    expect(store.getMessageQueueSnapshot().map((entry) => entry.text)).toEqual(["then summarize"]);
  } finally {
    app.unmount();
    app.cleanup();
    input.destroy();
    output.destroy();
    store.setInterruptHandler(null);
    store.clearQueue();
    store.consumeFlushQueue();
    store.clearOutputs();
  }
});

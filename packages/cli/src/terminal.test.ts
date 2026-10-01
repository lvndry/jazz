import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  INK_RENDER_OPTIONS,
  InkTerminalService,
  PlainTerminalService,
  maskSecret,
} from "./terminal";
import { store } from "./ui/store";

describe("INK_RENDER_OPTIONS", () => {
  /**
   * Regression: incrementalRendering breaks Ink's interactive components.
   *
   * When enabled, Ink's Yoga layout engine miscomputes available widths,
   * causing:
   *   - Select/wizard prompts to break (arrow keys emit newlines instead
   *     of navigating)
   *   - Multi-line ANSI content (diffs) to be aggressively truncated or
   *     completely invisible
   *
   * See: https://github.com/anomalyco/jazz/issues/XXX
   */
  test("must NOT enable incrementalRendering", () => {
    expect(INK_RENDER_OPTIONS).not.toHaveProperty("incrementalRendering");
  });

  test("must disable patchConsole to prevent flickering", () => {
    expect(INK_RENDER_OPTIONS.patchConsole).toBe(false);
  });

  test("must disable exitOnCtrlC so app handles SIGINT", () => {
    expect(INK_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
  });
});

describe("PlainTerminalService", () => {
  function plainTerminal(input: PassThrough = new PassThrough()) {
    const written = { stdout: "", stderr: "" };
    const terminal = new PlainTerminalService({
      input,
      output: { write: (chunk: string) => (written.stdout += chunk) },
      errorOutput: { write: (chunk: string) => (written.stderr += chunk) },
    });
    return { terminal, input, written };
  }

  /**
   * Regression: `ask` used to resolve at once with its default. The chat loop
   * read that as an empty Enter and prompted again, spinning at full CPU until
   * memory ran out. With stdin open and silent, `ask` has to keep waiting.
   */
  test("ask waits for stdin instead of answering on its own", async () => {
    const { terminal, input } = plainTerminal();
    const answer = Effect.runPromise(terminal.ask("You:", { defaultValue: "invented" }));
    const pending = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30));

    expect(await Promise.race([answer, pending])).toBe("pending");

    input.write("hello\n");
    expect(await answer).toBe("hello");
    terminal.cleanup();
  });

  test("ask resolves undefined once stdin has ended", async () => {
    const { terminal, input } = plainTerminal();
    input.end();

    expect(await Effect.runPromise(terminal.ask("You:"))).toBeUndefined();
    expect(await Effect.runPromise(terminal.password("API key:"))).toBeUndefined();
  });

  test("a line that fails validation is refused on stderr, never kept", async () => {
    const { terminal, input, written } = plainTerminal();
    input.end("\n");

    const answer = await Effect.runPromise(
      terminal.ask("Name:", {
        validate: (value) => (value.length > 0 ? true : "Name is required"),
      }),
    );

    expect(answer).toBeUndefined();
    expect(written.stderr).toContain("Name is required");
  });

  test("menus and confirmations resolve undefined instead of a default", async () => {
    const { terminal, written } = plainTerminal();

    expect(
      await Effect.runPromise(terminal.confirm("Enable notifications?", true)),
    ).toBeUndefined();
    expect(
      await Effect.runPromise(
        terminal.select("Keep working in the background?", {
          choices: [{ name: "Low risk", value: "low-risk" }],
          default: "low-risk",
        }),
      ),
    ).toBeUndefined();
    expect(
      await Effect.runPromise(terminal.search("Provider?", { choices: ["openai"] })),
    ).toBeUndefined();
    expect(
      await Effect.runPromise(terminal.checkbox("Workflows?", { choices: ["a"], default: ["a"] })),
    ).toBeUndefined();
    expect(written.stdout).toBe("");
    expect(written.stderr).toContain("needs an interactive terminal");
  });

  test("errors, warnings and debug lines go to stderr; regular output to stdout", async () => {
    const { terminal, written } = plainTerminal();

    await Effect.runPromise(
      Effect.all([
        terminal.info("info line"),
        terminal.log("data line"),
        terminal.error("error line"),
        terminal.warn("warn line"),
        terminal.debug("debug line"),
      ]),
    );

    expect(written.stdout).toContain("info line");
    expect(written.stdout).toContain("data line");
    expect(written.stdout).not.toContain("error line");
    expect(written.stderr).toContain("error line");
    expect(written.stderr).toContain("warn line");
    expect(written.stderr).toContain("debug line");
  });
});

/** The production terminal port must accept meaning before any width-dependent layout. */
describe("Ink terminal semantic acceptance", () => {
  const terminal = Object.create(InkTerminalService.prototype) as InkTerminalService;
  test("long user source remains unchanged at different terminal widths", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const text = "a long user sentence with Unicode 界 and e\u0301 ".repeat(10);
    try {
      for (const width of [32, 120]) {
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
        store.clearOutputs();
        Effect.runSync(terminal.user(text));
        store.flushOutputBatchNow();
        expect(store.getDocumentSnapshot().entries[0]?.content).toEqual({ kind: "user", text });
      }
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, "columns");
      else Object.defineProperty(process.stdout, "columns", descriptor);
      store.clearOutputs();
    }
  });

  test("secret prompt echo stores only masked text and cannot enter recall history", async () => {
    store.clearOutputs();
    const secret = "a-very-private-secret-that-must-never-enter-source";
    const pending = Effect.runPromise(terminal.ask("API key:", { secret: true }));
    await Promise.resolve();
    store.getPromptSnapshot()!.resolve(secret);
    expect(await pending).toBe(secret);
    store.flushOutputBatchNow();
    expect(store.getDocumentSnapshot().entries[0]?.content).toEqual({
      kind: "user",
      text: maskSecret(secret),
    });
    expect(JSON.stringify(store.getDocumentSnapshot())).not.toContain(secret);
    expect(store.getInputHistory()).not.toContain(secret);
    store.clearOutputs();
  });

  test("answered and cancelled prompts persist unwrapped words only", async () => {
    store.clearOutputs();
    const message = "a deliberately long prompt label ".repeat(5);
    const answer = "a deliberately long answer ".repeat(5);
    const pending = Effect.runPromise(terminal.ask(message, { simple: true }));
    await Promise.resolve();
    store.getPromptSnapshot()!.resolve(answer);
    expect(await pending).toBe(answer);
    store.flushOutputBatchNow();
    expect(store.getDocumentSnapshot().entries[0]?.content).toEqual({
      kind: "user",
      text: `${message} ${answer}`,
    });
    const cancelled = Effect.runPromise(terminal.ask(message, { simple: true, cancellable: true }));
    await Promise.resolve();
    store.getPromptSnapshot()!.reject!();
    expect(await cancelled).toBeUndefined();
    store.flushOutputBatchNow();
    expect(store.getDocumentSnapshot().entries.at(-1)?.content).toEqual({
      kind: "notice",
      tone: "log",
      text: `${message} (cancelled)`,
    });
    store.clearOutputs();
  });
});

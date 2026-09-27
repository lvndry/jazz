/**
 * Test rendering for the fullscreen (OpenTUI) interface that settles input deterministically.
 *
 * `renderForTest` has the signature of `testRender` from `@opentui/react/test-utils` and
 * returns the same setup, with two differences a test can rely on:
 *
 * - Every simulated key, paste and mouse event runs inside React's `act()`, so the state
 *   updates it causes are committed before the call returns. No test has to wait a macrotask
 *   for React's scheduler.
 * - A lone Escape is resolved at once. The input parser normally holds a bare ESC byte for a
 *   short real-time window, because it could be the start of an arrow-key sequence; here the
 *   parser is flushed the same way its own timer flushes it, without the wait.
 *
 * After mounting, the React act environment is on only inside those `act()` scopes. Store
 * updates and timers a test triggers outside them are scheduled the way they are in
 * production, without the "not wrapped in act" warning. Wrap a store write in
 * `updateForTest` to commit it at once, and use `frameWhen` for state that changes on a real
 * timer or after real I/O. `flush()` paints the frame.
 *
 * Usage:
 *
 * ```tsx
 * const rendered = await renderForTest(<FullscreenBridge />, { width: 100, height: 24 });
 * await rendered.renderOnce();
 * rendered.mockInput.pressKey("ESCAPE");
 * await rendered.flush();
 * rendered.renderer.destroy();
 * ```
 */

import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";

type TestSetup = Awaited<ReturnType<typeof testRender>>;
type RendererOptions = Parameters<typeof testRender>[1];

/** The parts of OpenTUI's renderer that decide when buffered input bytes become key events. */
interface PendingInputRenderer {
  readonly stdinParser: { tryForceFlush(): void } | null;
  drainStdinParser(): void;
}

function setActEnvironment(enabled: boolean): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = enabled;
}

/** Run `callback` as one act() scope, with the act environment on only for its duration. */
function inActScope<Result>(callback: () => Result): Result {
  setActEnvironment(true);
  try {
    let result: Result | undefined;
    void act(() => {
      result = callback();
    });
    return result as Result;
  } finally {
    setActEnvironment(false);
  }
}

async function inAsyncActScope<Result>(callback: () => Promise<Result>): Promise<Result> {
  setActEnvironment(true);
  try {
    let result: Result | undefined;
    await act(async () => {
      result = await callback();
    });
    return result as Result;
  } finally {
    setActEnvironment(false);
  }
}

/** Turn any bytes the parser is still holding (a lone ESC) into key events now. */
function flushPendingInput(renderer: TestSetup["renderer"]): void {
  const internals = renderer as unknown as PendingInputRenderer;
  internals.stdinParser?.tryForceFlush();
  internals.drainStdinParser();
}

function wrapInputMethods<Target extends object>(
  target: Target,
  renderer: TestSetup["renderer"],
): Target {
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(target)) {
    if (typeof method !== "function") {
      wrapped[name] = method;
      continue;
    }
    wrapped[name] = (...args: unknown[]): unknown => {
      let pending: unknown;
      inActScope(() => {
        pending = (method as (...methodArgs: unknown[]) => unknown)(...args);
        flushPendingInput(renderer);
      });
      if (pending instanceof Promise) {
        return inAsyncActScope(async () => {
          const settled: unknown = await pending;
          flushPendingInput(renderer);
          return settled;
        });
      }
      return pending;
    };
  }
  return wrapped as Target;
}

/** Mount `node` in an OpenTUI test renderer whose input settles deterministically. */
export async function renderForTest(node: ReactNode, options: RendererOptions): Promise<TestSetup> {
  const setup = await testRender(node, options);
  setActEnvironment(false);

  const destroy = setup.renderer.destroy.bind(setup.renderer);
  setup.renderer.destroy = () => {
    inActScope(destroy);
  };

  return {
    ...setup,
    mockInput: wrapInputMethods(setup.mockInput, setup.renderer),
    mockMouse: wrapInputMethods(setup.mockMouse, setup.renderer),
  };
}

/**
 * Run a store update or any other state change a test drives from outside the tree as one
 * act() scope, so it is committed before the test reads the frame.
 */
export function updateForTest(change: () => void): void {
  inActScope(change);
}

/** How long `frameWhen` waits for work that finishes outside React before giving up. */
export const EXTERNAL_WORK_DEADLINE_MS = 3_000;

/** How often `frameWhen` repaints and re-checks while it waits. */
const FRAME_POLL_INTERVAL_MS = 10;

/**
 * Repaint until the frame satisfies `predicate`, for state that changes on a real timer or
 * after real I/O (the approval arming delay, the elapsed-time ticker, the @-mention file scan).
 * It waits for the condition rather than for a fixed time, so a loaded machine only makes it
 * slower. Returns the first matching frame, or the last frame at the deadline so the caller's
 * own assertion reports what was on screen.
 */
export async function frameWhen(
  setup: Pick<TestSetup, "flush" | "captureCharFrame">,
  predicate: (frame: string) => boolean,
  deadlineMs: number = EXTERNAL_WORK_DEADLINE_MS,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (predicate(frame) || Date.now() - startedAt >= deadlineMs) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_INTERVAL_MS));
  }
}

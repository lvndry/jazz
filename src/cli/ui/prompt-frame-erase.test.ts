import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { Box, Static, Text, render } from "ink";
import React from "react";
import { INK_RENDER_OPTIONS } from "@/services/terminal";

/**
 * Regression: dismissing a prompt used to crop the tail of the previous
 * agent response out of scrollback.
 *
 * `store.setPrompt(null)` called Ink's `instance.clear()` to erase the prompt
 * frame eagerly. `Ink.clear()` erases the frame and then re-syncs log-update
 * to believe those lines are still painted, so the next render erased the
 * same line count a second time — walking (frameHeight - 1) lines up into
 * settled scrollback and overwriting them with the next entry.
 *
 * These tests pin the two halves of the fix: Ink cleans up a shrinking frame
 * on its own, and it only does so once.
 */

const ERASE_LINE = "[2K";

class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 30;
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  get writableLength(): number {
    return 0;
  }
}

function createFakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = (() => stdin) as NodeJS.ReadStream["setRawMode"];
  stdin.resume = (() => stdin) as NodeJS.ReadStream["resume"];
  stdin.pause = (() => stdin) as NodeJS.ReadStream["pause"];
  stdin.ref = (() => stdin) as NodeJS.ReadStream["ref"];
  stdin.unref = (() => stdin) as NodeJS.ReadStream["unref"];
  stdin.read = (() => null) as NodeJS.ReadStream["read"];
  return stdin;
}

const PROMPT_FRAME_LINES = ["PROMPT-A", "PROMPT-B", "PROMPT-C", "FOOTER"];

function countErasedLines(writes: readonly string[]): number {
  return writes.join("").split(ERASE_LINE).length - 1;
}

interface Harness {
  stdout: FakeTty;
  dismissPromptAndEcho: () => void;
  unmount: () => void;
}

function mountHarness(): Harness {
  const stdout = new FakeTty();
  let setPromptOpen: (open: boolean) => void = () => {};
  let setEntries: (update: (prev: readonly string[]) => string[]) => void = () => {};

  function Harness(): React.ReactElement {
    const [entries, updateEntries] = React.useState<readonly string[]>([
      "response line 1",
      "response line 2",
    ]);
    const [promptOpen, updatePromptOpen] = React.useState(true);
    setEntries = updateEntries;
    setPromptOpen = updatePromptOpen;
    return React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Static<string>, {
        items: entries as string[],
        children: (item: string) => React.createElement(Text, { key: item }, item),
      }),
      promptOpen
        ? React.createElement(
            Box,
            { flexDirection: "column" },
            ...PROMPT_FRAME_LINES.map((line) => React.createElement(Text, { key: line }, line)),
          )
        : null,
    );
  }

  const instance = render(React.createElement(Harness), {
    ...INK_RENDER_OPTIONS,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: createFakeStdin(),
    // Ink defaults to non-interactive under CI and never emits erase escapes
    // there. The bug only exists on the interactive path a real terminal
    // takes, so pin it explicitly rather than letting the environment decide.
    interactive: true,
  });

  return {
    stdout,
    dismissPromptAndEcho: () => {
      setPromptOpen(false);
      setEntries((prev) => [...prev, "> A and C"]);
    },
    unmount: () => instance.unmount(),
  };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 150));
};

describe("prompt dismissal does not crop scrollback", () => {
  test("Ink erases the shrinking prompt frame exactly once", async () => {
    const harness = mountHarness();
    await settle();

    harness.stdout.writes.length = 0;
    harness.dismissPromptAndEcho();
    await settle();

    const erased = countErasedLines(harness.stdout.writes);
    // The painted frame is the prompt lines plus Ink's trailing newline row.
    expect(erased).toBe(PROMPT_FRAME_LINES.length + 1);

    harness.unmount();
  });

  test("the new scrollback entry is written after the frame erase, not over it", async () => {
    const harness = mountHarness();
    await settle();

    harness.stdout.writes.length = 0;
    harness.dismissPromptAndEcho();
    await settle();

    const combined = harness.stdout.writes.join("");
    expect(combined).toContain("> A and C");
    // Nothing may be erased once the entry has landed — a second erase pass
    // is what used to eat the settled lines above it.
    const afterEntry = combined.slice(combined.indexOf("> A and C"));
    expect(afterEntry).not.toContain(ERASE_LINE);

    harness.unmount();
  });
});

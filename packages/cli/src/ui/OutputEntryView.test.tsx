import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { TerminalDimensionsProvider } from "./contexts/TerminalDimensionsContext";
import { toolReceipt } from "./models/receipt";
import { OutputEntryView } from "./OutputEntryView";
import type { OutputEntryWithId } from "./types";

function streamEntry(
  message: string,
  kind: "response" | "reasoning" = "response",
): OutputEntryWithId {
  return {
    id: "e1",
    type: "streamContent",
    message:
      kind === "response"
        ? { kind: "agent", markdown: message }
        : { kind: "reasoning", text: message, label: "Reasoning" },
    timestamp: new Date(),
  };
}

function toolEntry(receipt: ReturnType<typeof toolReceipt>): OutputEntryWithId {
  return {
    id: "e1",
    type: "log",
    message: { kind: "tool", receipt },
    timestamp: new Date(),
  };
}

describe("OutputEntryView, streamContent", () => {
  test("carries markdown styling through the shared parser", () => {
    const output = renderToString(
      <OutputEntryView
        entry={streamEntry("**bold** and a list:\n- one")}
        addSpacing={false}
      />,
    );
    expect(output).not.toContain("**");
    expect(output).toContain("bold");
  });

  test("hard-wraps and carries the speaker rail, matching the live pending tail", () => {
    const long = Array.from({ length: 30 }, (_, index) => `word${String(index)}`).join(" ");
    const output = renderToString(
      <OutputEntryView
        entry={streamEntry(long)}
        addSpacing={false}
      />,
    );
    expect(output.split("\n").length).toBeGreaterThan(1);
  });
});

describe("OutputEntryView, tool receipts", () => {
  test("shows a command output preview under the receipt", () => {
    const stdout = "x".repeat(120);
    const output = renderToString(
      <OutputEntryView
        entry={toolEntry(
          toolReceipt({
            toolName: "execute_command",
            result: JSON.stringify({ stdout, stderr: "", exitCode: 0 }),
            durationMs: 12,
          }),
        )}
        addSpacing={false}
      />,
    );

    expect(output).toContain(stdout.slice(0, 20));
    expect(output).toContain("ctrl+o to expand");
  });
});

describe("OutputEntryView, user source", () => {
  test("wraps at current width inside the classic painter without changing source text", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const message = "words in a long user message ".repeat(15);
    const entry: OutputEntryWithId = { id: "user", type: "user", message, timestamp: new Date() };
    try {
      const outputs = [40, 100].map((width) => {
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
        return renderToString(
          <TerminalDimensionsProvider>
            <OutputEntryView
              entry={entry}
              addSpacing={false}
            />
          </TerminalDimensionsProvider>,
          { columns: width },
        );
      });
      expect(outputs[0]!.split("\n").length).toBeGreaterThan(outputs[1]!.split("\n").length);
      expect(entry.message).toBe(message);
      expect(outputs[0]).toContain("words in a long user message");
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, "columns");
      else Object.defineProperty(process.stdout, "columns", descriptor);
    }
  });
});

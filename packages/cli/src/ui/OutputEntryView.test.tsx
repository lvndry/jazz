import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { toolReceipt } from "./models/receipt";
import { OutputEntryView } from "./OutputEntryView";
import type { OutputEntryWithId } from "./types";

function streamEntry(
  message: string,
  kind: "response" | "reasoning" = "response",
): OutputEntryWithId {
  return { id: "e1", type: "streamContent", message, timestamp: new Date(), meta: { kind } };
}

function toolEntry(receipt: ReturnType<typeof toolReceipt>): OutputEntryWithId {
  return {
    id: "e1",
    type: "log",
    message: "",
    timestamp: new Date(),
    meta: { toolReceipt: receipt },
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
    expect(output).toContain("ctrl+e to expand");
  });
});

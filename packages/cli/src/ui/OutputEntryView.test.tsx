import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { OutputEntryView } from "./OutputEntryView";
import type { OutputEntryWithId } from "./types";

function streamEntry(
  message: string,
  kind: "response" | "reasoning" = "response",
): OutputEntryWithId {
  return { id: "e1", type: "streamContent", message, timestamp: new Date(), meta: { kind } };
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

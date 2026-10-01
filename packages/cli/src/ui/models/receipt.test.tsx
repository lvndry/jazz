import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import { reduceEvent, createAccumulator } from "../../presentation/activity-reducer";
import { CLIRenderer } from "../../presentation/cli-renderer";
import { stripAnsiCodes } from "../../utils/string-utils";
import { blocksFrom } from "../fullscreen/bridge";
import { transcriptRows } from "../fullscreen/Transcript";
import { getGlyphs } from "../glyphs";
import { OutputEntryView } from "../OutputEntryView";
import { receiptParts, receiptPlainText, summaryRestatesReason, toolReceipt } from "./receipt";

const glyphs = getGlyphs();

describe("toolReceipt", () => {
  it("names the outcome, never the result's content", () => {
    const receipt = toolReceipt({
      toolName: "ls",
      argsPreview: "packages",
      result: JSON.stringify({ entries: [{ name: "a" }, { name: "b" }] }),
      formattedResult: "a\nb",
      durationMs: 40,
    });
    expect(receipt.summary).toBe("2 entries");
    expect(receipt.detail).toBe("a\nb");
    expect(receiptPlainText(receipt, glyphs)).toBe("ls  packages  2 entries");
  });

  it("marks a declined call and says what it did not do", () => {
    const receipt = toolReceipt({
      toolName: "write_file",
      argsPreview: "notes.md",
      success: false,
      error: "rejected",
      result: JSON.stringify({ rejected: true }),
      durationMs: 0,
    });
    expect(receipt.status).toBe("denied");
    expect(receipt.reason).toBeUndefined();
    expect(receiptPlainText(receipt, glyphs)).toBe(
      `write_file  notes.md  denied ${glyphs.bullet} the file was not changed`,
    );
  });

  it("names a call the executor refused before it started", () => {
    const receipt = toolReceipt({
      toolName: "manage_todos",
      success: false,
      error:
        "Invalid tool call: the arguments did not match the tool's parameters (todos[0].content: expected string, received undefined)",
      result: "Error",
      durationMs: 0,
    });
    const text = receiptPlainText(receipt, glyphs);
    expect(text).toStartWith("manage_todos");
    expect(text).toContain("todos[0].content");
    expect(text).not.toContain("\n");
  });

  it("strips another renderer's styling out of the expandable detail", () => {
    const receipt = toolReceipt({
      toolName: "edit_file",
      result: JSON.stringify({ diff: "+a" }),
      formattedResult: "\u001b[32m+a\u001b[39m",
      durationMs: 1,
    });
    expect(receipt.detail).toBe("+a");
  });
});

describe("receiptParts", () => {
  it("closes with the duration only when asked", () => {
    const receipt = toolReceipt({ toolName: "pwd", result: "/tmp", durationMs: 4_100 });
    expect(receiptParts(receipt, glyphs).some((part) => part.kind === "duration")).toBe(false);
    expect(receiptPlainText(receipt, glyphs, { duration: true })).toEndWith("4.1s");
  });

  it("does not repeat a failure reason the outcome already states", () => {
    expect(summaryRestatesReason("token expired…", "token expired")).toBe(true);
    expect(summaryRestatesReason("3 files", "token expired")).toBe(false);
  });
});

describe("the same receipt on fullscreen, Ink and plain output", () => {
  const event = {
    type: "tool_execution_complete" as const,
    toolCallId: "call-1",
    toolName: "mcp_slack_post_message",
    result: "",
    durationMs: 0,
    success: false,
    error: "401 token expired",
  };
  const facts = [
    "mcp_slack_post_message",
    "401 token expired",
    "nothing was sent",
    "/mcp reconnect slack",
    "to fix",
  ];

  it("states the same facts everywhere", () => {
    const accumulator = createAccumulator("jazz");
    const [entry] = reduceEvent(accumulator, event).outputs;
    if (entry === undefined) {
      throw new Error("the reducer printed nothing");
    }

    const blocks = blocksFrom([{ ...entry, id: "e1" }], "", []);
    const fullscreen = transcriptRows(blocks, { width: 120, height: 30 })
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join("\n");

    const ink = stripAnsiCodes(
      renderToString(
        <OutputEntryView
          entry={{ ...entry, id: "e1" }}
          addSpacing={false}
        />,
        { columns: 160 },
      ),
    );

    const plain = stripAnsiCodes(
      (
        new CLIRenderer({
          displayConfig: { mode: "rendered", showReasoning: false, showToolExecution: true },
          streamingConfig: {},
          showMetrics: false,
          agentName: "jazz",
        }) as unknown as { renderEvent(value: typeof event): string | null }
      ).renderEvent(event) ?? "",
    );

    const words = (text: string): string => text.replace(/\s+/g, " ");
    for (const fact of facts) {
      expect(words(fullscreen)).toContain(fact);
      expect(words(ink)).toContain(fact);
      expect(words(plain)).toContain(fact);
    }
  });
});

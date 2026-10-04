import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { writeToolResult } from "@/core/agent/context/tool-result-offload";
import type { ToolExecutionResult } from "@/core/types/tools";
import { formatToolResultForContext } from "@/core/utils/tool-result-formatter";
import { createRetrieveToolResultTool, RETRIEVE_PAGE_CHARS } from "./context";

function retrieve(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    createRetrieveToolResultTool().execute(args, {
      agentId: "agent-1",
      conversationId: "conv-1",
    }) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

describe("retrieve_tool_result", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-retrieve-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = previousHome;
    }
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("returns a short body whole", async () => {
    writeToolResult("agent-1", "conv-1", "call_1", "short body");
    expect(await retrieve({ tool_call_id: "call_1" })).toEqual({
      success: true,
      result: "short body",
    });
  });

  it("pages a long body, each page fitting one tool result, until the end", async () => {
    const body = Array.from({ length: 6_000 }, (_, index) => `line ${String(index)}`).join("\n");
    writeToolResult("agent-1", "conv-1", "call_1", body);

    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await retrieve({ tool_call_id: "call_1", offset });
      const text = String(page.result);
      expect(formatToolResultForContext("retrieve_tool_result", text)).toBe(text);
      const footer = text.slice(text.lastIndexOf("\n[chars "));
      pages.push(text.slice(0, text.length - footer.length));
      const next = /offset (\d+) for the next page/.exec(footer);
      if (next === null) {
        expect(footer).toContain("this is the end");
        break;
      }
      offset = Number(next[1]);
    }
    expect(pages.length).toBe(Math.ceil(body.length / RETRIEVE_PAGE_CHARS));
    expect(pages.join("")).toBe(body);
  });

  it("frames every page of a body that holds external content", async () => {
    const provenance = { kind: "external", source: "web_fetch https://example.com" } as const;
    writeToolResult("agent-1", "conv-1", "call_1", "x".repeat(RETRIEVE_PAGE_CHARS * 2), provenance);
    const secondPage = await retrieve({ tool_call_id: "call_1", offset: RETRIEVE_PAGE_CHARS });
    expect(secondPage.untrusted).toEqual(provenance);
  });

  it("refuses an offset past the end", async () => {
    writeToolResult("agent-1", "conv-1", "call_1", "short body");
    const past = await retrieve({ tool_call_id: "call_1", offset: 100 });
    expect(past.success).toBe(false);
    expect(past.error).toContain("past the end");
  });
});

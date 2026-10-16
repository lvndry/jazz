import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { writeToolResult } from "@/core/agent/context/tool-result-offload";
import type { ToolExecutionResult } from "@/core/types/tools";
import { formatToolResultForContext } from "@/core/utils/tool-result-formatter";
import {
  createContextInfoTool,
  createRetrieveToolResultTool,
  RETRIEVE_PAGE_CHARS,
} from "./context";

function retrieve(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    createRetrieveToolResultTool().execute(args, {
      agentId: "agent-1",
      conversationId: "conv-1",
    }) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

function contextInfo(tokenStats?: {
  currentTokens: number;
  maxTokens: number;
  warnThresholdRatio: number;
  compactThresholdRatio: number;
}): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    createContextInfoTool().execute(
      {},
      { agentId: "agent-1", ...(tokenStats && { tokenStats }) },
    ) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

describe("context_info", () => {
  const ladder = { maxTokens: 1_000, warnThresholdRatio: 0.6, compactThresholdRatio: 0.75 };

  it("fails instead of reporting made-up numbers when the run passes no stats", async () => {
    const outcome = await contextInfo();
    expect(outcome.success).toBe(false);
    expect(outcome.result).toBeNull();
  });

  it("reports usage against the run's own compaction threshold", async () => {
    const outcome = await contextInfo({ ...ladder, currentTokens: 300 });
    expect(outcome.result).toMatchObject({
      estimatedTokensUsed: 300,
      maxTokens: 1_000,
      remainingTokens: 700,
      percentUsed: 30,
      compactsAtPercent: 75,
    });
  });

  it("changes its recommendation at the configured warn and compact thresholds", async () => {
    const recommendationAt = async (currentTokens: number) =>
      ((await contextInfo({ ...ladder, currentTokens })).result as { recommendation: string })
        .recommendation;

    const belowWarn = await recommendationAt(599);
    const atWarn = await recommendationAt(600);
    const belowCompact = await recommendationAt(749);
    const atCompact = await recommendationAt(750);

    expect(atWarn).not.toBe(belowWarn);
    expect(belowCompact).toBe(atWarn);
    expect(atCompact).not.toBe(belowCompact);
  });
});

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

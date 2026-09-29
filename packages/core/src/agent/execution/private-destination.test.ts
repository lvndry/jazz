import { FileSystem } from "@effect/platform";
import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { AppConfig } from "@/core/types/config";
import type {
  ApprovalRequest,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@/core/types/tools";
import {
  privateDestinationNeedsApproval,
  unlistedPrivateAddressesFor,
} from "./private-destination";
import { ToolExecutor } from "./tool-executor";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { isRunParkRequested } from "../run/park-signal";
import { testConfigLayer } from "../test-config";
import { silentLogger } from "../test-logger";

const PRIVATE_URL = "http://192.168.1.50:8123/api/states";

function webFetchCall(url: string): ToolCall {
  return {
    id: "call-1",
    type: "function",
    function: { name: "read_pdf", arguments: JSON.stringify({ url }) },
  };
}

function harness(options: {
  readonly canPrompt: boolean;
  readonly approve: boolean;
  readonly allowPrivateHosts?: readonly string[];
  readonly riskLevel?: "read-only" | "high-risk";
}) {
  const grants: (readonly string[] | undefined)[] = [];
  const approvals: ApprovalRequest[] = [];
  const writes: { key: string; value: unknown }[] = [];
  let appConfig: Partial<AppConfig> =
    options.allowPrivateHosts === undefined
      ? {}
      : { network: { allowPrivateHosts: options.allowPrivateHosts } };
  const configService = {
    get appConfig() {
      return Effect.sync(() => appConfig);
    },
    set: (key: string, value: unknown) =>
      Effect.sync(() => {
        writes.push({ key, value });
        appConfig = { ...appConfig, network: { allowPrivateHosts: value as string[] } };
      }),
  } as unknown as AgentConfigService;
  const registry = {
    getTool: (name: string) =>
      Effect.succeed({
        name,
        egress: true,
        riskLevel: options.riskLevel ?? "read-only",
        approvalExecuteToolName: undefined,
      }),
    executeTool: (
      _name: string,
      _args: unknown,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult> =>
      Effect.sync(() => {
        grants.push(context.approvedPrivateAddresses);
        return { success: true, result: { content: "states" } };
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
        return { approved: options.approve };
      }),
  } as unknown as PresentationService;
  const layer = Layer.mergeAll(
    Layer.succeed(ToolRegistryTag, registry),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(LoggerServiceTag, silentLogger),
    Layer.succeed(AgentConfigServiceTag, configService),
    Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem),
  );

  const run = (context: ToolExecutionContext, call: ToolCall) =>
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
            config: { persona: "default", llm: { provider: "openai", model: "m" } },
          },
          conversationId: "c",
          provider: "openai",
          model: "m",
        } as never),
        "a",
        "c",
        "a",
      ).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        readonly { result: unknown; success: boolean }[],
        Error
      >,
    );
  return { grants, approvals, writes, run };
}

const context: ToolExecutionContext = {
  agentId: "a",
  conversationId: "c",
  unrestrictedTools: true,
  getAutoApprovePolicy: () => "read-only",
  conversationMessages: [],
};

describe("unlistedPrivateAddressesFor", () => {
  function addresses(url: string, allowPrivateHosts: readonly string[] = []) {
    return Effect.runPromise(
      unlistedPrivateAddressesFor("read_pdf", true, { url }, { agentId: "a" }).pipe(
        Effect.provide(testConfigLayer({ network: { allowPrivateHosts } })),
      ),
    );
  }

  it("names a private address the global list does not hold", async () => {
    expect(await addresses(PRIVATE_URL)).toEqual(["192.168.1.50"]);
    expect(await addresses("http://127.0.0.1:4747/runs")).toEqual(["127.0.0.1"]);
  });

  it("is empty for a public address and for a listed one", async () => {
    expect(await addresses("http://93.184.216.34/")).toEqual([]);
    expect(await addresses(PRIVATE_URL, ["192.168.1.0/24"])).toEqual([]);
  });
});

describe("privateDestinationNeedsApproval", () => {
  it("asks below high-risk unless the tool is explicitly allowlisted", () => {
    expect(privateDestinationNeedsApproval(["10.0.0.2"], "low-risk", false)).toBe(true);
    expect(privateDestinationNeedsApproval(["10.0.0.2"], undefined, false)).toBe(true);
    expect(privateDestinationNeedsApproval(["10.0.0.2"], "high-risk", false)).toBe(false);
    expect(privateDestinationNeedsApproval(["10.0.0.2"], "low-risk", true)).toBe(false);
    expect(privateDestinationNeedsApproval([], "read-only", false)).toBe(false);
  });
});

describe("ToolExecutor private-destination approval", () => {
  it("asks instead of failing, then saves the approved address and grants it to the call", async () => {
    const { grants, approvals, writes, run } = harness({ canPrompt: true, approve: true });
    const exit = await run(context, webFetchCall(PRIVATE_URL));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.message).toContain("192.168.1.50");
    expect(approvals[0]?.message).toContain("network.allowPrivateHosts");
    expect(writes).toEqual([{ key: "network.allowPrivateHosts", value: ["192.168.1.50"] }]);
    expect(grants).toEqual([["192.168.1.50"]]);
  });

  it("keeps existing entries when it adds one", async () => {
    const { writes, run } = harness({
      canPrompt: true,
      approve: true,
      allowPrivateHosts: ["homeassistant.local"],
    });
    await run(context, webFetchCall(PRIVATE_URL));
    expect(writes).toEqual([
      { key: "network.allowPrivateHosts", value: ["homeassistant.local", "192.168.1.50"] },
    ]);
  });

  it("runs a listed address unasked", async () => {
    const { grants, approvals, writes, run } = harness({
      canPrompt: true,
      approve: false,
      allowPrivateHosts: ["192.168.1.50"],
    });
    await run(context, webFetchCall(PRIVATE_URL));
    expect(approvals).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(grants).toEqual([undefined]);
  });

  it("neither runs nor saves when the person declines", async () => {
    const { grants, writes, run } = harness({ canPrompt: true, approve: false });
    const exit = await run(context, webFetchCall(PRIVATE_URL));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value[0]?.success).toBe(false);
    }
    expect(grants).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("parks an unattended run until someone answers", async () => {
    const { grants, run } = harness({ canPrompt: false, approve: true });
    const exit = await run({ ...context, parkWhenUnattended: true }, webFetchCall(PRIVATE_URL));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(isRunParkRequested(failure)).toBe(true);
    }
    expect(grants).toEqual([]);
  });

  it("saves the address when a resumed run carries the person's approval", async () => {
    const { grants, approvals, writes, run } = harness({ canPrompt: false, approve: false });
    await run(
      {
        ...context,
        parkWhenUnattended: true,
        resolvedApprovals: new Map([["call-1", { approved: true }]]),
      },
      webFetchCall(PRIVATE_URL),
    );
    expect(approvals).toHaveLength(0);
    expect(writes).toEqual([{ key: "network.allowPrivateHosts", value: ["192.168.1.50"] }]);
    expect(grants).toEqual([["192.168.1.50"]]);
  });

  it("lets a high-risk run through for this call without widening the list", async () => {
    const { grants, approvals, writes, run } = harness({ canPrompt: true, approve: false });
    await run({ ...context, getAutoApprovePolicy: () => "high-risk" }, webFetchCall(PRIVATE_URL));
    expect(approvals).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(grants).toEqual([["192.168.1.50"]]);
  });

  it("adds the private-network reason to a gated tool's own approval and saves on approval", async () => {
    const { grants, approvals, writes, run } = harness({
      canPrompt: true,
      approve: true,
      riskLevel: "high-risk",
    });
    await run({ ...context, getAutoApprovePolicy: () => "low-risk" }, webFetchCall(PRIVATE_URL));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.message).toContain("Approving adds 192.168.1.50");
    expect(writes).toEqual([{ key: "network.allowPrivateHosts", value: ["192.168.1.50"] }]);
    expect(grants).toEqual([["192.168.1.50"]]);
  });
});

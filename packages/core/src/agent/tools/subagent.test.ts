import { file as bunFile } from "bun";
import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_SUBAGENT_ITERATIONS } from "@/core/constants/agent";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { LoggerService } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type {
  EphemeralRegionCollapse,
  EphemeralRegionKind,
  EphemeralRegionOptions,
  PresentationService,
} from "@/core/interfaces/presentation";
import type { Agent } from "@/core/types";
import { AgentRunner } from "../agent-runner";
import type { AgentRunnerOptions } from "../types";
import { createSubagentTools } from "./subagent";

const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
} as unknown as LoggerService;

interface PanelCalls {
  readonly opens: Array<{ kind: EphemeralRegionKind; label: string }>;
  readonly appends: Array<{ regionId: string; text: string }>;
  readonly collapses: Array<{
    regionId: string;
    label: string;
    outcome: EphemeralRegionCollapse;
  }>;
}

function createPresentationHarness(): {
  presentation: PresentationService;
  calls: PanelCalls;
} {
  const calls: PanelCalls = { opens: [], appends: [], collapses: [] };
  const presentation = {
    writeOutput: () => Effect.void,
    openEphemeralRegion: (kind: EphemeralRegionKind, label: string) => {
      calls.opens.push({ kind, label });
      return Effect.succeed("eph-test");
    },
    appendEphemeralRegion: (regionId: string, text: string) => {
      calls.appends.push({ regionId, text });
      return Effect.void;
    },
    collapseEphemeralRegion: (
      regionId: string,
      label: string,
      outcome: EphemeralRegionCollapse,
    ) => {
      calls.collapses.push({ regionId, label, outcome });
      return Effect.void;
    },
  } as unknown as PresentationService;
  return { presentation, calls };
}

const parentAgent: Agent = {
  id: "parent-agent",
  name: "Parent",
  description: "",
  config: { persona: "default" } as Agent["config"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

function getSpawnTool() {
  const tool = createSubagentTools().find((t) => t.name === "spawn_subagent");
  if (!tool) throw new Error("spawn_subagent tool not found");
  return tool;
}

function runSpawn(
  presentation: PresentationService,
  context: Record<string, unknown> = {},
): Promise<unknown> {
  return runSpawnArgs(presentation, { task: "do a thing", persona: "default" }, context);
}

function runSpawnArgs(
  presentation: PresentationService,
  args: Record<string, unknown>,
  context: Record<string, unknown> = {},
): Promise<unknown> {
  const tool = getSpawnTool();
  const testLayer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(PresentationServiceTag, presentation),
  );
  return Effect.runPromise(
    (
      tool.execute(args, { agentId: parentAgent.id, parentAgent, ...context }) as Effect.Effect<
        unknown,
        unknown,
        LoggerService | PresentationService
      >
    ).pipe(Effect.provide(testLayer)),
  );
}

const candidateResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: { type: "array", items: { type: "string" } },
  },
} as const;

describe("summarize_context", () => {
  const agent: Agent = {
    ...parentAgent,
    config: {
      persona: "default",
      llmProvider: "openai",
      llmModel: "gpt-4",
      tools: [],
      // Small enough that most of the conversation is old rather than recent.
      maxContextTokens: 2000,
    } as Agent["config"],
  };

  function conversationAfterEarlierCompaction(): Array<{
    role: string;
    content: string;
    kind?: string;
    memorySource?: { id: string; text: string };
  }> {
    const messages: Array<{
      role: string;
      content: string;
      kind?: string;
      memorySource?: { id: string; text: string };
    }> = [
      { role: "system", content: "system" },
      { role: "assistant", content: "Earlier work: migrated auth module.", kind: "summary" },
    ];
    for (let index = 0; index < 20; index++) {
      const userText = `ask ${index} ` + "detail ".repeat(100);
      messages.push({
        role: "user",
        content: userText,
        memorySource: { id: `user:${index}`, text: userText },
      });
      messages.push({ role: "assistant", content: `answer ${index} ` + "text ".repeat(100) });
    }
    return messages;
  }

  it("merges an earlier summary into the new one instead of dropping it", async () => {
    const summarizerInputs: string[] = [];
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      summarizerInputs.push(options.userInput);
      return Effect.succeed({
        content: "merged summary",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const tool = createSubagentTools().find((t) => t.name === "summarize_context");
      if (!tool) throw new Error("summarize_context tool not found");

      let compacted: ReadonlyArray<{ content: string; kind?: string }> | undefined;
      const context: Record<string, unknown> = {
        conversationId: "conv-summarize-tool",
        conversationMessages: conversationAfterEarlierCompaction(),
        compactConversation: (messages: ReadonlyArray<{ content: string; kind?: string }>) => {
          compacted = messages;
        },
      };
      const { presentation } = createPresentationHarness();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );

      await Effect.runPromise(
        (
          tool.execute({}, { agentId: agent.id, parentAgent: agent, ...context }) as Effect.Effect<
            unknown,
            unknown,
            LoggerService | PresentationService
          >
        ).pipe(Effect.provide(testLayer)),
      );

      expect(summarizerInputs.join("\n")).toContain("migrated auth module");
      const summaries = compacted?.filter((message) => message.kind === "summary") ?? [];
      expect(summaries.map((message) => message.content)).toEqual(["merged summary"]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Compacting through the tool rather than waiting for the window to fill must not
   * decide whether durable facts reach memory. The run's own gate travels on the tool
   * context, and its absence means no.
   */
  async function runSummarizeContext(gate?: boolean): Promise<string[]> {
    const agentsRun: string[] = [];
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      agentsRun.push(options.agent.id);
      return Effect.succeed({
        content: "merged summary",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const tool = createSubagentTools().find((t) => t.name === "summarize_context");
      if (!tool) throw new Error("summarize_context tool not found");

      const context: Record<string, unknown> = {
        conversationId: "conv-summarize-gate",
        conversationMessages: conversationAfterEarlierCompaction(),
        compactConversation: () => {},
        ...(gate === undefined ? {} : { allowMemoryExtraction: gate }),
      };
      const { presentation } = createPresentationHarness();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );

      await Effect.runPromise(
        (
          tool.execute({}, { agentId: agent.id, parentAgent: agent, ...context }) as Effect.Effect<
            unknown,
            unknown,
            LoggerService | PresentationService
          >
        ).pipe(Effect.provide(testLayer)),
      );

      return agentsRun;
    } finally {
      spy.mockRestore();
    }
  }

  it("extracts memories when the run that called the tool may persist them", async () => {
    expect(await runSummarizeContext(true)).toContain("memory-extractor");
  });

  it("skips extraction when the run forbids it", async () => {
    expect(await runSummarizeContext(false)).not.toContain("memory-extractor");
  });

  it("skips extraction when the context carries no gate at all", async () => {
    expect(await runSummarizeContext()).not.toContain("memory-extractor");
  });
});

describe("spawn_subagent auto-approve inheritance", () => {
  it("forwards the parent's auto-approve policy and allowlists to the sub-agent", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, {
        getAutoApprovePolicy: () => true as const,
        autoApprovedCommands: ["git status"],
        autoApprovedTools: ["read_file"],
        onAutoApproveCommand: () => Effect.void,
        onAutoApproveTool: () => {},
      });

      expect(captured).toBeDefined();
      const forwardedPolicy = captured?.autoApprovePolicy;
      const resolved = typeof forwardedPolicy === "function" ? forwardedPolicy() : forwardedPolicy;
      expect(resolved).toBe(true);
      expect(captured?.autoApprovedCommands).toEqual(["git status"]);
      expect(captured?.autoApprovedTools).toEqual(["read_file"]);
      expect(captured?.ephemeralRegionId).toBe("eph-test");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent trace context", () => {
  it("passes the parent run, session, and dispatch call to the child", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({
        content: "done",
        conversationId: "child-conversation",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });
    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, {
        telemetryTraceParent: {
          topRunId: "root-run",
          parentRunId: "parent-run",
          sessionId: "root-session",
        },
        toolCallId: "dispatch-1",
      });
      expect(captured?.telemetryParent).toEqual({
        topRunId: "root-run",
        parentRunId: "parent-run",
        sessionId: "root-session",
        parentToolCallId: "dispatch-1",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent structured results", () => {
  it("returns a validated result and child telemetry alongside the summary", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(() => {
      return Effect.succeed({
        content: JSON.stringify({
          summary: "Found two candidates.",
          result: { candidates: ["first", "second"] },
        }),
        costUSD: 0.0125,
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      const events: Array<Record<string, unknown>> = [];
      const response = (await runSpawnArgs(
        presentation,
        {
          task: "return candidates",
          resultSchema: candidateResultSchema,
          resultName: "research candidates",
        },
        {
          emitEvent: (event: Record<string, unknown>) =>
            Effect.sync(() => {
              events.push(event);
            }),
        },
      )) as {
        success: boolean;
        result: {
          summary: string;
          structuredResult: { candidates: string[] };
          child: { costUSD?: number; costKnown: boolean };
        };
      };

      expect(response.success).toBe(true);
      expect(response.result.summary).toBe("Found two candidates.");
      expect(response.result.structuredResult).toEqual({ candidates: ["first", "second"] });
      expect(response.result.child.costUSD).toBe(0.0125);
      expect(response.result.child.costKnown).toBe(true);
      expect(events.find((event) => event["type"] === "subagent_result")).toMatchObject({
        subagentId: expect.any(String),
        durationMs: expect.any(Number),
        costUSD: 0.0125,
        costKnown: true,
        structuredResult: { requested: true, valid: true, resultName: "research candidates" },
      });
      expect(spy.mock.calls[0]?.[0].userInput).toContain("STRUCTURED COMPLETION REQUIRED");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns validation errors and telemetry when the child result misses required data", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(() => {
      return Effect.succeed({
        content: JSON.stringify({ summary: "Incomplete result.", result: {} }),
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      const events: Array<Record<string, unknown>> = [];
      const response = (await runSpawnArgs(
        presentation,
        { task: "return candidates", resultSchema: candidateResultSchema },
        {
          emitEvent: (event: Record<string, unknown>) =>
            Effect.sync(() => {
              events.push(event);
            }),
        },
      )) as { success: boolean; error?: string; result: { validationErrors: string[] } };

      expect(response.success).toBe(false);
      expect(response.error).toContain("failed validation");
      expect(response.result.validationErrors).toHaveLength(1);
      expect(events.find((event) => event["type"] === "subagent_result")).toMatchObject({
        structuredResult: { requested: true, valid: false, errorCount: 1 },
        costKnown: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an unsupported result schema before starting a child", async () => {
    const spy = spyOn(AgentRunner, "runRecursive");

    try {
      const { presentation } = createPresentationHarness();
      const response = (await runSpawnArgs(presentation, {
        task: "return candidates",
        resultSchema: { type: "array" },
      })) as { success: boolean; error?: string };

      expect(response.success).toBe(false);
      expect(response.error).toContain("root type");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent event bracket", () => {
  it("names the sub-agent on both events so a consumer can pair them", async () => {
    const events: Array<Record<string, unknown>> = [];
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(
      () =>
        Effect.succeed({
          content: "done",
          conversationId: "conv-test",
          messages: [],
        }) as ReturnType<typeof AgentRunner.runRecursive>,
    );

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, {
        emitEvent: (event: Record<string, unknown>) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      const start = events.find((event) => event["type"] === "subagent_start");
      const complete = events.find((event) => event["type"] === "subagent_complete");
      expect(start?.["agentName"]).toBeDefined();
      // Without this the complete event reaches the stream through the parent's
      // renderer and gets attributed to the parent instead of the specialist.
      expect(complete?.["agentName"]).toBe(start?.["agentName"]);
      expect(typeof complete?.["durationMs"]).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent persona handling", () => {
  it("passes the persona through as config rather than restating it in the task", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      const tool = getSpawnTool();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );
      await Effect.runPromise(
        (
          tool.execute(
            { task: "trace the call sites", persona: "coder" },
            { agentId: parentAgent.id, parentAgent },
          ) as Effect.Effect<unknown, unknown, LoggerService | PresentationService>
        ).pipe(Effect.provide(testLayer)),
      );

      // The persona reaches the child as config, so AgentPromptBuilder resolves
      // the packaged PERSONA.md into its system prompt.
      expect(captured?.agent.config.persona).toBe("coder");
      // The task itself must not carry a competing one-line persona blurb.
      expect(captured?.userInput).not.toContain("specialist");
      expect(captured?.userInput).toContain("trace the call sites");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent reasoning effort", () => {
  function captureSpawn(): {
    readonly captured: () => Omit<AgentRunnerOptions, "internal"> | undefined;
    readonly spy: ReturnType<typeof spyOn>;
  } {
    let seen: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      seen = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });
    return { captured: () => seen, spy };
  }

  function runSpawnWithArgs(
    presentation: PresentationService,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = getSpawnTool();
    const testLayer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, mockLogger),
      Layer.succeed(PresentationServiceTag, presentation),
    );
    return Effect.runPromise(
      (
        tool.execute(args, { agentId: parentAgent.id, parentAgent }) as Effect.Effect<
          unknown,
          unknown,
          LoggerService | PresentationService
        >
      ).pipe(Effect.provide(testLayer)),
    );
  }

  it("overrides the parent's effort when provided", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const effortParent: Agent = {
        ...parentAgent,
        config: {
          persona: "default",
          reasoning: "medium",
        } as Agent["config"],
      };
      const tool = getSpawnTool();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );
      await Effect.runPromise(
        (
          tool.execute(
            { task: "deep review", persona: "coder", reasoning: "high" },
            { agentId: effortParent.id, parentAgent: effortParent },
          ) as Effect.Effect<unknown, unknown, LoggerService | PresentationService>
        ).pipe(Effect.provide(testLayer)),
      );

      expect(captured()?.agent.config.reasoning).toBe("high");
    } finally {
      spy.mockRestore();
    }
  });

  it("inherits the parent's effort when omitted", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const effortParent: Agent = {
        ...parentAgent,
        config: {
          persona: "default",
          reasoning: "medium",
        } as Agent["config"],
      };
      const tool = getSpawnTool();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );
      await Effect.runPromise(
        (
          tool.execute(
            { task: "do a thing", persona: "default" },
            { agentId: effortParent.id, parentAgent: effortParent },
          ) as Effect.Effect<unknown, unknown, LoggerService | PresentationService>
        ).pipe(Effect.provide(testLayer)),
      );

      expect(captured()?.agent.config.reasoning).toBe("medium");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an invalid effort value", async () => {
    const { spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const result = (await runSpawnWithArgs(presentation, {
        task: "do a thing",
        reasoning: "maximum",
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent tool ceiling", () => {
  it("caps the child at the parent's effective tools", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, {
        effectiveToolNames: new Set(["read_file", "grep", "spawn_subagent"]),
      });

      expect(captured?.toolAllowlist).toEqual(["read_file", "grep", "spawn_subagent"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("sets no allowlist when the parent's toolset is unknown", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation);

      expect(captured?.toolAllowlist).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent nesting depth", () => {
  function captureSpawn(): {
    readonly captured: () => Omit<AgentRunnerOptions, "internal"> | undefined;
    readonly spy: ReturnType<typeof spyOn>;
  } {
    let seen: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      seen = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });
    return { captured: () => seen, spy };
  }

  it("starts a top-level run's child at depth 1", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation);

      expect(captured()?.subagentDepth).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("increments the depth for each further level", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, { subagentDepth: 2, maxSubagentDepth: 3 });

      expect(captured()?.subagentDepth).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to spawn once the depth limit is reached", async () => {
    const { spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const result = (await runSpawn(presentation, {
        subagentDepth: 3,
        maxSubagentDepth: 3,
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("nesting limit");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("honours a configured limit other than the default", async () => {
    const { spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const result = (await runSpawn(presentation, {
        subagentDepth: 1,
        maxSubagentDepth: 1,
      })) as { success: boolean };

      expect(result.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("lets a configured limit of 0 stop delegation outright", async () => {
    const { spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      const result = (await runSpawn(presentation, { maxSubagentDepth: 0 })) as {
        success: boolean;
      };

      expect(result.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("opens no panel when the spawn is refused", async () => {
    const { spy } = captureSpawn();

    try {
      const { presentation, calls } = createPresentationHarness();
      await runSpawn(presentation, { subagentDepth: 3, maxSubagentDepth: 3 });

      expect(calls.opens).toHaveLength(0);
      expect(calls.collapses).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent iteration budget", () => {
  function captureSpawn(): {
    readonly captured: () => Omit<AgentRunnerOptions, "internal"> | undefined;
    readonly spy: ReturnType<typeof spyOn>;
  } {
    let seen: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      seen = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });
    return { captured: () => seen, spy };
  }

  it("gives the child the configured sub-agent budget", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, { maxSubagentIterations: 12 });

      expect(captured()?.maxIterations).toBe(12);
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to the sub-agent default when config sets nothing", async () => {
    const { captured, spy } = captureSpawn();

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation);

      expect(captured()?.maxIterations).toBe(DEFAULT_MAX_SUBAGENT_ITERATIONS);
      expect(DEFAULT_MAX_SUBAGENT_ITERATIONS).toBeLessThan(DEFAULT_MAX_ITERATIONS);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent presentation", () => {
  it("does not import the TUI from core", async () => {
    const source = await bunFile(new URL("./subagent.ts", import.meta.url)).text();
    expect(source).not.toContain("@/cli/");
  });

  it("opens, appends, and collapses the panel on success", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(() => {
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });

    try {
      const { presentation, calls } = createPresentationHarness();
      await runSpawn(presentation);

      expect(calls.opens).toEqual([{ kind: "subagent", label: "Sub-Agent (default)" }]);
      expect(calls.appends).toEqual([{ regionId: "eph-test", text: "Task: do a thing" }]);
      expect(calls.collapses).toHaveLength(1);
      expect(calls.collapses[0]?.regionId).toBe("eph-test");
      expect(calls.collapses[0]?.label).toBe("Sub-Agent (default)");
      expect(calls.collapses[0]?.outcome.status).toBe("completed");
      expect(calls.collapses[0]?.outcome.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("collapses the panel as failed when the sub-run errors", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(() => {
      return Effect.fail(new Error("subagent exploded")) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      const { presentation, calls } = createPresentationHarness();
      await expect(runSpawn(presentation)).rejects.toThrow("subagent exploded");
      expect(calls.collapses).toHaveLength(1);
      expect(calls.collapses[0]?.outcome.status).toBe("failed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("spawn_subagent steering", () => {
  function captureChildOptions(): {
    readonly captured: { options?: Omit<AgentRunnerOptions, "internal"> };
    readonly restore: () => void;
  } {
    const captured: { options?: Omit<AgentRunnerOptions, "internal"> } = {};
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured.options = options;
      return Effect.succeed({
        content: "done",
        conversationId: "conv-test",
        messages: [],
      }) as ReturnType<typeof AgentRunner.runRecursive>;
    });
    return { captured, restore: () => spy.mockRestore() };
  }

  it("delivers messages addressed to the child's region, framed as guidance", async () => {
    const { presentation } = createPresentationHarness();
    const waiting = ["try the corner cells first"];
    const takenFrom: string[] = [];
    const steerable = {
      ...presentation,
      takeEphemeralRegionMessage: (regionId: string) => {
        takenFrom.push(regionId);
        return Effect.succeed(waiting.shift());
      },
    } as PresentationService;
    const { captured, restore } = captureChildOptions();
    try {
      await runSpawn(steerable);
      const check = captured.options?.checkQueuedMessage;
      expect(check).toBeDefined();
      const delivered = check?.();
      expect(delivered).toContain("try the corner cells first");
      expect(delivered).toContain("continue the task");
      expect(check?.()).toBeUndefined();
      expect(takenFrom).toEqual(["eph-test", "eph-test"]);
    } finally {
      restore();
    }
  });

  it("gives the child no queue on a surface that cannot address it", async () => {
    const { presentation } = createPresentationHarness();
    const { captured, restore } = captureChildOptions();
    try {
      await runSpawn(presentation);
      expect(captured.options?.checkQueuedMessage).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("marks the panel as a delegated run with its full brief, not only the preview", async () => {
    const opened: Array<EphemeralRegionOptions | undefined> = [];
    const { presentation } = createPresentationHarness();
    const recording = {
      ...presentation,
      openEphemeralRegion: (
        _kind: EphemeralRegionKind,
        _label: string,
        options?: EphemeralRegionOptions,
      ) => {
        opened.push(options);
        return Effect.succeed("eph-test");
      },
      takeEphemeralRegionMessage: () => Effect.succeed(undefined),
    } as PresentationService;
    const task = `Solve the board. ${"Constraint. ".repeat(20)}`;
    const { restore } = captureChildOptions();
    try {
      await runSpawnArgs(recording, { task, persona: "default" });
      expect(opened).toEqual([{ agentRun: { task, acceptsMessages: true } }]);
    } finally {
      restore();
    }
  });
});

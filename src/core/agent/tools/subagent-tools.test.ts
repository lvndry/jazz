import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_SUBAGENT_ITERATIONS } from "@/core/constants/agent";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { LoggerService } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type {
  EphemeralRegionCollapse,
  EphemeralRegionKind,
  PresentationService,
} from "@/core/interfaces/presentation";
import type { Agent } from "@/core/types";
import { AgentRunner } from "../agent-runner";
import type { AgentRunnerOptions } from "../types";
import { createSubagentTools } from "./subagent-tools";

const mockLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  setLogGroup: () => Effect.void,
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
  model: "test-model",
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
  const tool = getSpawnTool();
  const testLayer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, mockLogger),
    Layer.succeed(PresentationServiceTag, presentation),
  );
  return Effect.runPromise(
    (
      tool.execute(
        { task: "do a thing", persona: "default" },
        { agentId: parentAgent.id, parentAgent, ...context },
      ) as Effect.Effect<unknown, unknown, LoggerService | PresentationService>
    ).pipe(Effect.provide(testLayer)),
  );
}

describe("spawn_subagent auto-approve inheritance", () => {
  it("forwards the parent's auto-approve policy and allowlists to the sub-agent", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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

describe("spawn_subagent persona handling", () => {
  it("passes the persona through as config rather than restating it in the task", async () => {
    let captured: Omit<AgentRunnerOptions, "internal"> | undefined;
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation((options) => {
      captured = options;
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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
      // the packaged persona.md into its system prompt.
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
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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
        config: { persona: "default", reasoningEffort: "medium" } as Agent["config"],
      };
      const tool = getSpawnTool();
      const testLayer = Layer.mergeAll(
        Layer.succeed(LoggerServiceTag, mockLogger),
        Layer.succeed(PresentationServiceTag, presentation),
      );
      await Effect.runPromise(
        (
          tool.execute(
            { task: "deep review", persona: "coder", reasoningEffort: "high" },
            { agentId: effortParent.id, parentAgent: effortParent },
          ) as Effect.Effect<unknown, unknown, LoggerService | PresentationService>
        ).pipe(Effect.provide(testLayer)),
      );

      expect(captured()?.agent.config.reasoningEffort).toBe("high");
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
        config: { persona: "default", reasoningEffort: "medium" } as Agent["config"],
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

      expect(captured()?.agent.config.reasoningEffort).toBe("medium");
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
        reasoningEffort: "maximum",
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
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
    });

    try {
      const { presentation } = createPresentationHarness();
      await runSpawn(presentation, {
        parentToolNames: ["read_file", "grep", "spawn_subagent"],
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
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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
    const source = await Bun.file(new URL("./subagent-tools.ts", import.meta.url)).text();
    expect(source).not.toContain("@/cli/");
  });

  it("opens, appends, and collapses the panel on success", async () => {
    const spy = spyOn(AgentRunner, "runRecursive").mockImplementation(() => {
      return Effect.succeed({ content: "done", messages: [] }) as ReturnType<
        typeof AgentRunner.runRecursive
      >;
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

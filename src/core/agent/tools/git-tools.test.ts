import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { exec } from "node:child_process";
import { createFileSystemContextServiceLayer } from "../../../services/shell";
import {
  createGitAddTool,
  createGitBranchTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitLogTool,
  createGitPullTool,
  createGitPushTool,
  createGitStatusTool,
} from "./git-tools";
import { createToolRegistryLayer, type Tool, type ToolExecutionResult } from "./tool-registry";

function getCurrentBranch(): Effect.Effect<string, Error> {
  return Effect.async((resume) => {
    exec("git rev-parse --abbrev-ref HEAD", (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || error.message;
        resume(Effect.fail(new Error(message)));
        return;
      }
      const branch = stdout.trim();
      resume(Effect.succeed(branch.length > 0 ? branch : "HEAD"));
    });
  });
}

describe("Git Tools", () => {
  const createTestLayer = () => {
    const shellLayer = createFileSystemContextServiceLayer();
    const toolRegistryLayer = createToolRegistryLayer();
    return Layer.mergeAll(
      toolRegistryLayer,
      Layer.provide(shellLayer, NodeFileSystem.layer),
      NodeFileSystem.layer,
    );
  };

  // Helper to verify tool structure
  function verifyToolStructure<R = never>(
    tool: Tool<R>,
    expectedName: string,
    shouldHaveApproval: boolean,
  ) {
    expect(tool.name).toBe(expectedName);
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20); // Ensure description is meaningful
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters).toHaveProperty("_def");
    expect(tool.execute).toBeDefined();
    expect(typeof tool.execute).toBe("function");
    expect(tool.createSummary).toBeDefined();
    expect(typeof tool.createSummary).toBe("function");

    if (shouldHaveApproval) {
      expect(tool.approvalExecuteToolName).toBeDefined();
      expect(typeof tool.approvalExecuteToolName).toBe("string");
    }
  }

  it("should create git_status tool with proper structure", () => {
    const tool = createGitStatusTool();
    verifyToolStructure(tool, "git_status", false);
  });

  it("should create git_log tool with proper structure", () => {
    const tool = createGitLogTool();
    verifyToolStructure(tool, "git_log", false);
  });

  it("should create git_add tool with approval requirement", () => {
    const tool = createGitAddTool();
    verifyToolStructure(tool, "git_add", true);
  });

  it("should create git_commit tool with approval requirement", () => {
    const tool = createGitCommitTool();
    verifyToolStructure(tool, "git_commit", true);
  });

  it("should create git_diff tool with proper structure", () => {
    const tool = createGitDiffTool();
    verifyToolStructure(tool, "git_diff", false);
  });

  it("should create git_push tool with approval requirement", () => {
    const tool = createGitPushTool();
    verifyToolStructure(tool, "git_push", true);
  });

  it("should create git_pull tool with approval requirement", () => {
    const tool = createGitPullTool();
    verifyToolStructure(tool, "git_pull", true);
  });

  it("should create git_branch tool with proper structure", () => {
    const tool = createGitBranchTool();
    verifyToolStructure(tool, "git_branch", false);
  });

  it("should create git_checkout tool with approval requirement", () => {
    const tool = createGitCheckoutTool();
    verifyToolStructure(tool, "git_checkout", true);
  });

  it("should require approval for destructive git operations", async () => {
    const tools = [
      {
        name: "git_add",
        create: createGitAddTool,
        validArgs: { files: ["test.txt"], all: false },
      },
      {
        name: "git_commit",
        create: createGitCommitTool,
        validArgs: { message: "test commit" },
      },
      {
        name: "git_push",
        create: createGitPushTool,
        validArgs: {},
      },
      {
        name: "git_pull",
        create: createGitPullTool,
        validArgs: {},
      },
      {
        name: "git_checkout",
        create: createGitCheckoutTool,
        validArgs: { branch: "test-branch" },
      },
    ];

    for (const { create, validArgs } of tools) {
      const tool = create();
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      // Try to execute with valid args but without approval - should require approval
      const result = await Effect.runPromise(
        Effect.provide(
          tool.execute(validArgs, context),
          createTestLayer(),
        ) as Effect.Effect<ToolExecutionResult, Error, never>,
      );

      // Tools with approval should return approval required
      expect(result.success).toBe(false);
      expect(result.result).toBeDefined();
      if (result.result && typeof result.result === "object") {
        expect(result.result).toHaveProperty("approvalRequired", true);
        expect(result.result).toHaveProperty("message");
        expect(typeof (result.result as { message: string }).message).toBe("string");
      }
    }
  });

  it("should execute git_status tool", async () => {
    const testEffect = Effect.gen(function* () {
      const tool = createGitStatusTool();
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      const result = yield* tool.execute({}, context);
      return result;
    });

    const result = await Effect.runPromise(
      testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
        ToolExecutionResult,
        Error,
        never
      >,
    );

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        hasChanges: boolean;
        rawStatus: string;
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(typeof gitResult.hasChanges).toBe("boolean");
      expect(typeof gitResult.rawStatus).toBe("string");
    }
  });

  it("should execute git_log tool", async () => {
    const testEffect = Effect.gen(function* () {
      const tool = createGitLogTool();
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      const result = yield* tool.execute({ limit: 5, oneline: true }, context);
      return result;
    });

    const result = await Effect.runPromise(
      testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
        ToolExecutionResult,
        Error,
        never
      >,
    );

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        commitCount: number;
        commits: Array<{ hash: string }>;
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(typeof gitResult.commitCount).toBe("number");
      expect(Array.isArray(gitResult.commits)).toBe(true);
    }
  });

  it("should execute git_diff tool", async () => {
    let selectedBranch = "HEAD";
    const testEffect = Effect.gen(function* () {
      const tool = createGitDiffTool();
      const branch = yield* getCurrentBranch().pipe(Effect.catchAll(() => Effect.succeed("HEAD")));
      selectedBranch = branch;
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      const result = yield* tool.execute({ staged: true, branch }, context);
      return result;
    });

    const result = await Effect.runPromise(
      testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
        ToolExecutionResult,
        Error,
        never
      >,
    );

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        hasChanges: boolean;
        diff: string;
        options: {
          staged: boolean;
          branch?: string;
          commit?: string;
        };
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(typeof gitResult.hasChanges).toBe("boolean");
      expect(typeof gitResult.diff).toBe("string");
      expect(gitResult.options.staged).toBe(true);
      expect(gitResult.options.branch).toBe(selectedBranch);
    }
  });

  it("should execute git_branch tool", async () => {
    const testEffect = Effect.gen(function* () {
      const tool = createGitBranchTool();
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      const result = yield* tool.execute({ all: true, remote: false }, context);
      return result;
    });

    const result = await Effect.runPromise(
      testEffect.pipe(Effect.provide(createTestLayer())) as Effect.Effect<
        ToolExecutionResult,
        Error,
        never
      >,
    );

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        branches: string[];
        currentBranch?: string;
        options: {
          all?: boolean;
          remote?: boolean;
        };
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(Array.isArray(gitResult.branches)).toBe(true);
      expect(gitResult.options.all).toBe(true);
      expect(gitResult.options.remote).toBe(false);
    }
  });
});

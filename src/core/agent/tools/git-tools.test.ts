import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
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
import { createToolRegistryLayer } from "./tool-registry";

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

  it("should create git_status tool with proper structure", () => {
    const tool = createGitStatusTool();
    expect(tool.name).toBe("git_status");
    expect(tool.description).toContain("working tree status");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_log tool with proper structure", () => {
    const tool = createGitLogTool();
    expect(tool.name).toBe("git_log");
    expect(tool.description).toContain("commit history");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_add tool with approval requirement", () => {
    const tool = createGitAddTool();
    expect(tool.name).toBe("git_add");
    expect(tool.description).toContain("requires user approval");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_commit tool with approval requirement", () => {
    const tool = createGitCommitTool();
    expect(tool.name).toBe("git_commit");
    expect(tool.description).toContain("requires user approval");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_diff tool with proper structure", () => {
    const tool = createGitDiffTool();
    expect(tool.name).toBe("git_diff");
    expect(tool.description).toContain("changes between commits");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_push tool with approval requirement", () => {
    const tool = createGitPushTool();
    expect(tool.name).toBe("git_push");
    expect(tool.description).toContain("requires user approval");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_pull tool with approval requirement", () => {
    const tool = createGitPullTool();
    expect(tool.name).toBe("git_pull");
    expect(tool.description).toContain("requires user approval");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_branch tool with proper structure", () => {
    const tool = createGitBranchTool();
    expect(tool.name).toBe("git_branch");
    expect(tool.description).toContain("branches");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
  });

  it("should create git_checkout tool with approval requirement", () => {
    const tool = createGitCheckoutTool();
    expect(tool.name).toBe("git_checkout");
    expect(tool.description).toContain("requires user approval");
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(tool.createSummary).toBeDefined();
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

    const result = await Effect.runPromise(testEffect.pipe(Effect.provide(createTestLayer())));

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

    const result = await Effect.runPromise(testEffect.pipe(Effect.provide(createTestLayer())));

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
    const testEffect = Effect.gen(function* () {
      const tool = createGitDiffTool();
      const context = {
        agentId: "test-agent",
        conversationId: "test-conversation",
      };

      const result = yield* tool.execute({ staged: true, branch: "main" }, context);
      return result;
    });

    const result = await Effect.runPromise(testEffect.pipe(Effect.provide(createTestLayer())));

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        hasChanges: boolean;
        diff: string;
        options: any;
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(typeof gitResult.hasChanges).toBe("boolean");
      expect(typeof gitResult.diff).toBe("string");
      expect(gitResult.options.staged).toBe(true);
      expect(gitResult.options.branch).toBe("main");
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

    const result = await Effect.runPromise(testEffect.pipe(Effect.provide(createTestLayer())));

    expect(result.success).toBe(true);
    if (result.success && typeof result.result === "object" && result.result !== null) {
      const gitResult = result.result as {
        workingDirectory: string;
        branches: string[];
        currentBranch?: string;
        options: any;
      };
      expect(gitResult.workingDirectory).toBeDefined();
      expect(Array.isArray(gitResult.branches)).toBe(true);
      expect(gitResult.options.all).toBe(true);
      expect(gitResult.options.remote).toBe(false);
    }
  });
});

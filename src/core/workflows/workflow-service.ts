import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import matter from "gray-matter";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "@/core/utils/markdown-index";
import {
  getBuiltinWorkflowsDirectory,
  getGlobalWorkflowsDirectory,
} from "@/core/utils/runtime-detection";

const WORKFLOW_DEFINITION_FILENAME = "WORKFLOW.md" as const;

/**
 * Workflow metadata extracted from WORKFLOW.md frontmatter.
 */
export interface WorkflowMetadata {
  /** Unique identifier for the workflow */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Path to the workflow directory */
  readonly path: string;
  /** Which agent to use (optional, defaults to "default") */
  readonly agent?: string;
  /** Cron schedule expression (e.g., "0 * * * *" for hourly) */
  readonly schedule?: string;
  /** Auto-approve policy for unattended execution */
  readonly autoApprove?: AutoApprovePolicy;
  /** Skills to load for this workflow */
  readonly skills?: readonly string[];
  /** Run missed workflows when Jazz starts */
  readonly catchUpOnStartup?: boolean;
  /** Max age (seconds) for catch-up runs */
  readonly maxCatchUpAge?: number;
  /** Maximum agent iterations per run (defaults to 50) */
  readonly maxIterations?: number;
}

/**
 * Full workflow content including the prompt.
 */
export interface WorkflowContent {
  readonly metadata: WorkflowMetadata;
  /** The markdown content (the actual prompt/instructions) */
  readonly prompt: string;
}

/**
 * Service for managing and loading workflows.
 */
export interface WorkflowService {
  /**
   * List all available workflows.
   * Returns metadata from all discovered WORKFLOW.md files.
   */
  readonly listWorkflows: () => Effect.Effect<readonly WorkflowMetadata[], Error>;

  /**
   * Load full workflow content by name.
   */
  readonly loadWorkflow: (workflowName: string) => Effect.Effect<WorkflowContent, Error>;

  /**
   * Get a workflow by name (metadata only).
   */
  readonly getWorkflow: (workflowName: string) => Effect.Effect<WorkflowMetadata, Error>;

  /**
   * Refresh the workflow cache (rescan directories).
   */
  readonly refreshCache: () => Effect.Effect<void, Error>;
}

export const WorkflowServiceTag = Context.GenericTag<WorkflowService>("WorkflowService");

/**
 * Parse workflow frontmatter into metadata.
 */
function parseWorkflowFrontmatter(
  data: Record<string, unknown>,
  workflowPath: string,
): WorkflowMetadata | null {
  const name = data["name"];
  const description = data["description"];

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  // Parse autoApprove - can be boolean or string
  const autoApprove = parseAutoApprove(data["autoApprove"]);

  // Parse skills array
  const skills = Array.isArray(data["skills"])
    ? data["skills"].filter((s): s is string => typeof s === "string")
    : undefined;

  // Build the metadata object using conditional spreading
  return {
    name,
    description,
    path: workflowPath,
    ...(typeof data["agent"] === "string" && { agent: data["agent"] }),
    ...(typeof data["schedule"] === "string" && { schedule: data["schedule"] }),
    ...(autoApprove !== undefined && { autoApprove }),
    ...(skills && skills.length > 0 && { skills }),
    ...(typeof data["catchUpOnStartup"] === "boolean" && {
      catchUpOnStartup: data["catchUpOnStartup"],
    }),
    ...(typeof data["maxCatchUpAge"] === "number" && { maxCatchUpAge: data["maxCatchUpAge"] }),
    ...(typeof data["maxIterations"] === "number" && { maxIterations: data["maxIterations"] }),
  };
}

/**
 * Parse autoApprove value from frontmatter.
 */
function parseAutoApprove(value: unknown): AutoApprovePolicy | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "read-only" || value === "low-risk" || value === "high-risk") {
    return value;
  }
  return undefined;
}

/**
 * Implementation of WorkflowService.
 */
export class WorkflowsLive implements WorkflowService {
  private constructor(
    private readonly globalCachePath: string,
    private readonly loadedWorkflows: Ref.Ref<Map<string, WorkflowContent>>,
    private readonly workflowCache: Ref.Ref<Map<string, WorkflowMetadata>>,
  ) {}

  public static readonly layer = Layer.effect(
    WorkflowServiceTag,
    Effect.gen(function* () {
      const homeDir = os.homedir();
      const globalCachePath = path.join(homeDir, ".jazz", "global-workflows-index.json");
      const loadedWorkflows = yield* Ref.make(new Map<string, WorkflowContent>());
      const workflowCache = yield* Ref.make(new Map<string, WorkflowMetadata>());

      return new WorkflowsLive(globalCachePath, loadedWorkflows, workflowCache);
    }),
  );

  listWorkflows(): Effect.Effect<readonly WorkflowMetadata[], Error> {
    return Effect.gen(
      function* (this: WorkflowsLive) {
        // Check if we have a cache
        const cache = yield* Ref.get(this.workflowCache);
        if (cache.size > 0) {
          return Array.from(cache.values());
        }

        // 1. Get Built-in Workflows (shipped with Jazz)
        const builtinWorkflows = yield* this.getBuiltinWorkflows();

        // 2. Get Global Workflows (~/.jazz/workflows)
        const globalWorkflows = yield* this.getGlobalWorkflows();

        // 3. Get Local Workflows (cwd)
        const localWorkflows = yield* this.scanLocalWorkflows();

        // 4. Merge (Local > Global > Built-in by name)
        const merged = mergeByName(builtinWorkflows, globalWorkflows, localWorkflows);
        const workflowMap = new Map<string, WorkflowMetadata>(merged.map((w) => [w.name, w]));

        // Update cache
        yield* Ref.set(this.workflowCache, workflowMap);

        return merged;
      }.bind(this),
    );
  }

  loadWorkflow(workflowName: string): Effect.Effect<WorkflowContent, Error> {
    return Effect.gen(
      function* (this: WorkflowsLive) {
        // Check memory cache first
        const loaded = yield* Ref.get(this.loadedWorkflows);
        const cached = loaded.get(workflowName);
        if (cached) return cached;

        // Find workflow path
        const allWorkflows = yield* this.listWorkflows();
        const metadata = allWorkflows.find((w: WorkflowMetadata) => w.name === workflowName);
        if (!metadata) {
          return yield* Effect.fail(new Error(`Workflow not found: ${workflowName}`));
        }

        const workflowMdPath = path.join(metadata.path, WORKFLOW_DEFINITION_FILENAME);

        // Parse WORKFLOW.md
        const content = yield* Effect.tryPromise({
          try: () => fs.readFile(workflowMdPath, "utf-8"),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        const parsed = matter(content);

        const workflowContent: WorkflowContent = {
          metadata,
          prompt: parsed.content.trim(),
        };

        // Cache in memory
        yield* Ref.update(this.loadedWorkflows, (map) =>
          new Map(map).set(workflowName, workflowContent),
        );

        return workflowContent;
      }.bind(this),
    );
  }

  getWorkflow(workflowName: string): Effect.Effect<WorkflowMetadata, Error> {
    return Effect.gen(
      function* (this: WorkflowsLive) {
        const allWorkflows = yield* this.listWorkflows();
        const workflow = allWorkflows.find((w: WorkflowMetadata) => w.name === workflowName);
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow not found: ${workflowName}`));
        }
        return workflow;
      }.bind(this),
    );
  }

  refreshCache(): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: WorkflowsLive) {
        yield* Ref.set(this.workflowCache, new Map());
        yield* Ref.set(this.loadedWorkflows, new Map());
        // Re-list to rebuild cache
        yield* this.listWorkflows();
      }.bind(this),
    );
  }

  private getGlobalWorkflows(): Effect.Effect<readonly WorkflowMetadata[], Error> {
    const globalWorkflowsDir = getGlobalWorkflowsDirectory();
    return loadCachedIndex<WorkflowMetadata>({
      cachePath: this.globalCachePath,
      scan: scanMarkdownIndex({
        dir: globalWorkflowsDir,
        fileName: WORKFLOW_DEFINITION_FILENAME,
        depth: 3,
        parse: (data, definitionDir) => parseWorkflowFrontmatter(data, definitionDir),
      }),
    });
  }

  private scanLocalWorkflows(): Effect.Effect<readonly WorkflowMetadata[], Error> {
    const cwd = process.cwd();
    return scanMarkdownIndex({
      dir: cwd,
      fileName: WORKFLOW_DEFINITION_FILENAME,
      depth: 4,
      parse: (data, definitionDir) => parseWorkflowFrontmatter(data, definitionDir),
    });
  }

  private getBuiltinWorkflows(): Effect.Effect<readonly WorkflowMetadata[], Error> {
    return Effect.gen(
      function* (this: WorkflowsLive) {
        const builtinDir = getBuiltinWorkflowsDirectory();
        if (!builtinDir) {
          return [];
        }
        return yield* scanMarkdownIndex({
          dir: builtinDir,
          fileName: WORKFLOW_DEFINITION_FILENAME,
          depth: 2,
          parse: (data, definitionDir) => parseWorkflowFrontmatter(data, definitionDir),
        });
      }.bind(this),
    );
  }
}

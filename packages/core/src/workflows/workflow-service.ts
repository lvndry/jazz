/**
 * `WorkflowService`: discovers and loads WORKFLOW.md definitions (global and
 * local), the automated prompts that agents run on a schedule. Jazz ships no
 * built-in workflows; shared ones come from the library via `jazz workflow install`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import matter from "gray-matter";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "@/core/utils/markdown-index";
import { getGlobalWorkflowsDirectory, getJazzHomeDirectory } from "@/core/utils/paths";

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
  /**
   * The approval policy a run of this workflow gets (see `resolveWorkflowApprovalPolicy`).
   * Unset means `false`: every gated tool call asks, or is declined when nobody can answer.
   */
  readonly autoApprove?: AutoApprovePolicy;
  /**
   * Why this workflow cannot run, when its frontmatter is invalid (an unknown `autoApprove`
   * value). Kept in the index rather than dropping the workflow, so `workflow list` and every
   * run path can name the problem instead of reporting the workflow missing.
   */
  readonly definitionError?: string;
  /** Skills to load for this workflow */
  readonly skills?: readonly string[];
  /** Whether a missed slot may be replayed after the daemon restarts. */
  readonly catchUpOnRestart?: boolean;
  /** Max age (seconds) for catch-up runs */
  readonly maxCatchUpAge?: number;
  /** Maximum agent iterations per run. Unset, the run falls back to config `maxIterations`, then `DEFAULT_MAX_ITERATIONS` */
  readonly maxIterations?: number;
  /** Per-run spend ceiling in USD. Unset, the run falls back to config `maxCostUSD`; unset at both means uncapped. */
  readonly maxCostUSD?: number;
  /** Per-run token ceiling. Unset, the run falls back to config `maxTokens`; unset at both means uncapped. */
  readonly maxTokens?: number;
  /** Wall-clock spend budget in ms. Unset, the run falls back to config `maxDurationMs`; unset at both means uncapped. */
  readonly maxDurationMs?: number;
  /** Notify channels (`notifications.channels.<name>`) that receive each run's answer. */
  readonly deliver?: readonly string[];
}

/** Everything a WORKFLOW.md declares about itself, before Jazz knows where it lives. */
export type WorkflowDefinition = Omit<WorkflowMetadata, "path">;

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
  const definition = parseWorkflowDefinition(data);
  return definition === null ? null : { ...definition, path: workflowPath };
}

/**
 * Parse WORKFLOW.md frontmatter into a definition, or `null` when the two
 * required fields (`name`, `description`) are missing. Shared by the local
 * loaders and by the library, which validates a download with the exact
 * rules the loaders will later apply to it.
 */
export function parseWorkflowDefinition(data: Record<string, unknown>): WorkflowDefinition | null {
  const name = data["name"];
  const description = data["description"];

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  const autoApprove = parseAutoApprove(data["autoApprove"]);

  // Parse skills array
  const skills = Array.isArray(data["skills"])
    ? data["skills"].filter((s): s is string => typeof s === "string")
    : undefined;

  const deliver = parseDeliver(data["deliver"]);

  // Build the metadata object using conditional spreading
  return {
    name,
    description,
    ...(typeof data["agent"] === "string" && { agent: data["agent"] }),
    ...(typeof data["schedule"] === "string" && { schedule: data["schedule"] }),
    ...(autoApprove.ok && autoApprove.policy !== undefined && { autoApprove: autoApprove.policy }),
    ...(!autoApprove.ok && { definitionError: autoApprove.error }),
    ...(skills && skills.length > 0 && { skills }),
    ...(typeof data["catchUpOnRestart"] === "boolean" && {
      catchUpOnRestart: data["catchUpOnRestart"],
    }),
    ...(typeof data["maxCatchUpAge"] === "number" && { maxCatchUpAge: data["maxCatchUpAge"] }),
    ...(typeof data["maxIterations"] === "number" && { maxIterations: data["maxIterations"] }),
    ...(typeof data["maxCostUSD"] === "number" && { maxCostUSD: data["maxCostUSD"] }),
    ...(typeof data["maxTokens"] === "number" && { maxTokens: data["maxTokens"] }),
    ...(typeof data["maxDurationMs"] === "number" && { maxDurationMs: data["maxDurationMs"] }),
    ...(deliver.length > 0 && { deliver }),
  };
}

/** `deliver: phone` or `deliver: [phone, team]`: the notify channels a result goes to. */
function parseDeliver(value: unknown): readonly string[] {
  const names = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Every value `autoApprove` accepts, in the order the tiers widen. */
export const WORKFLOW_AUTO_APPROVE_VALUES = [
  false,
  "read-only",
  "low-risk",
  "high-risk",
  true,
] as const satisfies readonly AutoApprovePolicy[];

export type AutoApproveParseResult =
  | { readonly ok: true; readonly policy: AutoApprovePolicy | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Parse an `autoApprove` frontmatter value. A missing value parses to `undefined`; anything
 * other than the unquoted booleans and the three tier names is an error naming the valid
 * values, so a typo such as `readonly` or a quoted `"false"` cannot quietly pick a tier.
 */
export function parseAutoApprove(value: unknown): AutoApproveParseResult {
  if (value === undefined) {
    return { ok: true, policy: undefined };
  }
  const match = WORKFLOW_AUTO_APPROVE_VALUES.find((candidate) => candidate === value);
  if (match !== undefined) {
    return { ok: true, policy: match };
  }
  const valid = WORKFLOW_AUTO_APPROVE_VALUES.map((candidate) => String(candidate)).join(", ");
  return {
    ok: false,
    error: `autoApprove ${JSON.stringify(value)} is not valid. Use one of: ${valid} (true and false unquoted).`,
  };
}

export type WorkflowApprovalPolicyResult =
  | { readonly ok: true; readonly policy: AutoApprovePolicy }
  | { readonly ok: false; readonly error: string };

/**
 * The approval policy a run of this workflow gets, for every path that runs one: a
 * schedule, catch-up after a restart, `jazz workflow run` with or without `--auto-approve`.
 * An unset `autoApprove` is `false`, which auto-approves nothing. Fails with the
 * workflow's `definitionError` when its frontmatter is invalid, so an invalid workflow
 * never runs.
 */
export function resolveWorkflowApprovalPolicy(
  workflow: Pick<WorkflowDefinition, "name" | "autoApprove" | "definitionError">,
): WorkflowApprovalPolicyResult {
  if (workflow.definitionError !== undefined) {
    return {
      ok: false,
      error: `Workflow "${workflow.name}" cannot run: ${workflow.definitionError}`,
    };
  }
  return { ok: true, policy: workflow.autoApprove ?? false };
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
      const globalCachePath = path.join(getJazzHomeDirectory(), "global-workflows-index.json");
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

        // 1. Get Global Workflows (~/.jazz/workflows)
        const globalWorkflows = yield* this.getGlobalWorkflows();

        // 2. Get Local Workflows (cwd)
        const localWorkflows = yield* this.scanLocalWorkflows();

        // 3. Merge (Local > Global by name)
        const merged = mergeByName(globalWorkflows, localWorkflows);
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
          catch: toError,
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
        yield* Effect.tryPromise({
          try: () => fs.rm(this.globalCachePath, { force: true }),
          catch: toError,
        });
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
    return scanMarkdownIndex({
      dir: path.join(process.cwd(), "workflows"),
      fileName: WORKFLOW_DEFINITION_FILENAME,
      depth: 3,
      parse: (data, definitionDir) => parseWorkflowFrontmatter(data, definitionDir),
    });
  }
}

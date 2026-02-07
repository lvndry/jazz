import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import matter from "gray-matter";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "@/core/utils/markdown-index";
import {
  getBuiltinGroovesDirectory,
  getGlobalGroovesDirectory,
} from "@/core/utils/runtime-detection";

const GROOVE_DEFINITION_FILENAME = "GROOVE.md" as const;

/**
 * Workflow metadata extracted from WORKFLOW.md frontmatter.
 */
export interface GrooveMetadata {
  /** Unique identifier for the workflow */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Path to the groove directory */
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
export interface GrooveContent {
  readonly metadata: GrooveMetadata;
  /** The markdown content (the actual prompt/instructions) */
  readonly prompt: string;
}

/**
 * Service for managing and loading workflows.
 */
export interface GrooveService {
  /**
   * List all available grooves.
   * Returns metadata from all discovered GROOVE.md files.
   */
  readonly listGrooves: () => Effect.Effect<readonly GrooveMetadata[], Error>;

  /**
   * Load full groove content by name.
   */
  readonly loadGroove: (grooveName: string) => Effect.Effect<GrooveContent, Error>;

  /**
   * Get a groove by name (metadata only).
   */
  readonly getGroove: (grooveName: string) => Effect.Effect<GrooveMetadata, Error>;

  /**
   * Refresh the groove cache (rescan directories).
   */
  readonly refreshCache: () => Effect.Effect<void, Error>;
}

export const GrooveServiceTag = Context.GenericTag<GrooveService>("GrooveService");

/**
 * Parse workflow frontmatter into metadata.
 */
function parseGrooveFrontmatter(
  data: Record<string, unknown>,
  groovePath: string,
): GrooveMetadata | null {
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
    path: groovePath,
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
 * Implementation of GrooveService.
 */
export class GroovesLive implements GrooveService {
  private constructor(
    private readonly globalCachePath: string,
    private readonly loadedGrooves: Ref.Ref<Map<string, GrooveContent>>,
    private readonly grooveCache: Ref.Ref<Map<string, GrooveMetadata>>,
  ) {}

  public static readonly layer = Layer.effect(
    GrooveServiceTag,
    Effect.gen(function* () {
      const homeDir = os.homedir();
      const globalCachePath = path.join(homeDir, ".jazz", "global-grooves-index.json");
      const loadedGrooves = yield* Ref.make(new Map<string, GrooveContent>());
      const grooveCache = yield* Ref.make(new Map<string, GrooveMetadata>());

      return new GroovesLive(globalCachePath, loadedGrooves, grooveCache);
    }),
  );

  listGrooves(): Effect.Effect<readonly GrooveMetadata[], Error> {
    return Effect.gen(function* (this: GroovesLive) {
      // Check if we have a cache
      const cache = yield* Ref.get(this.grooveCache);
      if (cache.size > 0) {
        return Array.from(cache.values());
      }

      // 1. Get Built-in Grooves (shipped with Jazz)
      const builtinGrooves = yield* this.getBuiltinGrooves();

      // 2. Get Global Grooves (~/.jazz/grooves)
      const globalGrooves = yield* this.getGlobalGrooves();

      // 3. Get Local Grooves (cwd)
      const localGrooves = yield* this.scanLocalGrooves();

      // 4. Merge (Local > Global > Built-in by name)
      const merged = mergeByName(builtinGrooves, globalGrooves, localGrooves);
      const grooveMap = new Map<string, GrooveMetadata>(merged.map((w) => [w.name, w]));

      // Update cache
      yield* Ref.set(this.grooveCache, grooveMap);

      return merged;
    }.bind(this));
  }

  loadGroove(grooveName: string): Effect.Effect<GrooveContent, Error> {
    return Effect.gen(function* (this: GroovesLive) {
      // Check memory cache first
      const loaded = yield* Ref.get(this.loadedGrooves);
      const cached = loaded.get(grooveName);
      if (cached) return cached;

      // Find groove path
      const allGrooves = yield* this.listGrooves();
      const metadata = allGrooves.find((w: GrooveMetadata) => w.name === grooveName);
      if (!metadata) {
        return yield* Effect.fail(new Error(`Groove not found: ${grooveName}`));
      }

      const grooveMdPath = path.join(metadata.path, GROOVE_DEFINITION_FILENAME);

      // Parse GROOVE.md
      const content = yield* Effect.tryPromise(() => fs.readFile(grooveMdPath, "utf-8"));
      const parsed = matter(content);

      const grooveContent: GrooveContent = {
        metadata,
        prompt: parsed.content.trim(),
      };

      // Cache in memory
      yield* Ref.update(this.loadedGrooves, (map) =>
        new Map(map).set(grooveName, grooveContent),
      );

      return grooveContent;
    }.bind(this));
  }

  getGroove(grooveName: string): Effect.Effect<GrooveMetadata, Error> {
    return Effect.gen(function* (this: GroovesLive) {
      const allGrooves = yield* this.listGrooves();
      const groove = allGrooves.find((w: GrooveMetadata) => w.name === grooveName);
      if (!groove) {
        return yield* Effect.fail(new Error(`Groove not found: ${grooveName}`));
      }
      return groove;
    }.bind(this));
  }

  refreshCache(): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: GroovesLive) {
      yield* Ref.set(this.grooveCache, new Map());
      yield* Ref.set(this.loadedGrooves, new Map());
      // Re-list to rebuild cache
      yield* this.listGrooves();
    }.bind(this));
  }

  private getGlobalGrooves(): Effect.Effect<readonly GrooveMetadata[], Error> {
    const globalWorkflowsDir = getGlobalGroovesDirectory();
    return loadCachedIndex<GrooveMetadata>({
      cachePath: this.globalCachePath,
      scan: scanMarkdownIndex({
        dir: globalWorkflowsDir,
        fileName: GROOVE_DEFINITION_FILENAME,
        depth: 3,
        parse: (data, definitionDir) => parseGrooveFrontmatter(data, definitionDir),
      }),
    });
  }

  private scanLocalGrooves(): Effect.Effect<readonly GrooveMetadata[], Error> {
    const cwd = process.cwd();
    return scanMarkdownIndex({
      dir: cwd,
      fileName: GROOVE_DEFINITION_FILENAME,
      depth: 4,
      parse: (data, definitionDir) => parseGrooveFrontmatter(data, definitionDir),
    });
  }

  private getBuiltinGrooves(): Effect.Effect<readonly GrooveMetadata[], Error> {
    return Effect.gen(function* (this: GroovesLive) {
      const builtinDir = getBuiltinGroovesDirectory();
      if (!builtinDir) {
        return [];
      }
      return yield* scanMarkdownIndex({
        dir: builtinDir,
        fileName: GROOVE_DEFINITION_FILENAME,
        depth: 2,
        parse: (data, definitionDir) => parseGrooveFrontmatter(data, definitionDir),
      });
    }.bind(this));
  }
}

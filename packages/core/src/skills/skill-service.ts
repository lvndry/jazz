/**
 * `SkillService`: discovers and loads Progressive-Disclosure skills (builtin,
 * global, agents, local), with keyword-based ranking for
 * the system-prompt skill index.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Option, Ref } from "effect";
import matter from "gray-matter";
import { toError } from "@/core/utils/errors";
import { PluginRuntimeServiceTag } from "../interfaces/plugin-runtime.js";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "../utils/markdown-index.js";
import {
  getAgentsSkillsDirectory,
  getBuiltinSkillsDirectory,
  getGlobalSkillsDirectory,
} from "../utils/paths.js";
import { matchesWholeWord } from "../utils/string";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  /** Filesystem directory holding the skill's SKILL.md, or "" for a plugin-provided skill. */
  readonly path: string;
  readonly source: "builtin" | "global" | "agents" | "local" | "plugin";
}

/**
 * Render the per-skill line shown in the system-prompt index.
 *
 * Returns the full `description`; the model reads it to decide which skill to
 * load, and the skill body is fetched JIT via `find_skills`.
 */
export function getSkillIndexLine(metadata: SkillMetadata): string {
  const desc = metadata.description.trim();
  return desc.length > 0 ? desc : metadata.name;
}

/**
 * Rank skills by relevance to a query.
 *
 * Deterministic keyword scoring (no embeddings, no LLM call):
 * - exact name match → +100
 * - name substring match → +20
 * - description word-boundary match → +2
 *
 * Ties broken alphabetically by name. Returns at most `limit` results
 * (default 5). Skills with score 0 are excluded.
 */
export function scoreSkillsForQuery(
  query: string,
  skills: readonly SkillMetadata[],
  limit = 5,
): readonly SkillMetadata[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || skills.length === 0) return [];

  const scored: Array<{ skill: SkillMetadata; score: number }> = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.includes(q)) score += 20;

    if (matchesWholeWord(skill.description.toLowerCase(), q)) score += 2;

    if (score > 0) scored.push({ skill, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });

  return scored.slice(0, limit).map((entry) => entry.skill);
}

export interface SkillsBySource {
  readonly builtin: readonly SkillMetadata[];
  readonly global: readonly SkillMetadata[];
  readonly agents: readonly SkillMetadata[];
  readonly local: readonly SkillMetadata[];
  readonly plugin: readonly SkillMetadata[];
}

export interface SkillContent {
  readonly metadata: SkillMetadata;
  readonly core: string; // Full SKILL.md content
  readonly sections: Map<string, string>; // Additional files
}

export interface SkillService {
  /**
   * List all available skills.
   * Returns a list of skills with their metadata (Level 1 Progressive Disclosure).
   */
  readonly listSkills: () => Effect.Effect<readonly SkillMetadata[], Error>;

  /**
   * List all skills grouped by source (builtin, global, local) before merging.
   */
  readonly listSkillsBySource: () => Effect.Effect<SkillsBySource, Error>;

  /**
   * Load full skill content (Level 2 Progressive Disclosure).
   * Reads SKILL.md.
   */
  readonly loadSkill: (skillName: string) => Effect.Effect<SkillContent, Error>;

  /**
   * Load specific section from skill (Level 3 Progressive Disclosure).
   * Reads referenced files.
   */
  readonly loadSkillSection: (
    skillName: string,
    sectionName: string,
  ) => Effect.Effect<string, Error>;
}

export const SkillServiceTag = Context.GenericTag<SkillService>("SkillService");

function parseSkillFrontmatter(
  data: Record<string, unknown>,
  skillPath: string,
  source: SkillMetadata["source"],
): SkillMetadata | null {
  const name = data["name"];
  const description = data["description"];

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  return {
    name,
    description,
    path: skillPath,
    source,
  };
}

/**
 * Implementation of SkillService
 */
export class SkillsLive implements SkillService {
  private constructor(
    private readonly globalCachePath: string,
    private readonly loadedSkills: Ref.Ref<Map<string, SkillContent>>,
    private readonly skillsListCache: Ref.Ref<readonly SkillMetadata[] | null>,
  ) {}

  public static readonly layer = Layer.effect(
    SkillServiceTag,
    Effect.gen(function* () {
      const homeDir = os.homedir();
      const globalCachePath = path.join(homeDir, ".jazz", "global-skills-index.json");
      const loadedSkills = yield* Ref.make(new Map<string, SkillContent>());
      const skillsListCache = yield* Ref.make<readonly SkillMetadata[] | null>(null);

      return new SkillsLive(globalCachePath, loadedSkills, skillsListCache);
    }),
  );

  listSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    return Effect.gen(
      function* (this: SkillsLive) {
        // Check cache first - skills are cached for the session since they don't change mid-conversation
        const cached = yield* Ref.get(this.skillsListCache);
        if (cached !== null) {
          return cached;
        }

        // 1. Get Built-in Skills (shipped with Jazz)
        const builtinSkills = yield* this.getBuiltinSkills();

        // 2. Get Global Skills (Cached, medium priority - ~/.jazz/skills)
        const globalSkills = yield* this.getGlobalSkills();

        // 3. Get Agents Skills (~/.agents/skills)
        const agentsSkills = yield* this.getAgentsSkills();

        // 4. Get Local Skills (Fresh scan, highest priority - cwd)
        const localSkills = yield* this.scanLocalSkills();

        // 5. Get plugin skills (global, lowest priority - anything else of the same name wins)
        const pluginSkills = yield* this.getPluginSkills();

        // 6. Merge (Local > Agents > Global > Built-in > Plugin by name; last arg wins)
        const merged = mergeByName(
          pluginSkills,
          builtinSkills,
          globalSkills,
          agentsSkills,
          localSkills,
        );

        // Cache for the session
        yield* Ref.set(this.skillsListCache, merged);

        return merged;
      }.bind(this),
    );
  }

  listSkillsBySource(): Effect.Effect<SkillsBySource, Error> {
    return Effect.gen(
      function* (this: SkillsLive) {
        const builtin = yield* this.getBuiltinSkills();
        const global = yield* this.getGlobalSkills();
        const agents = yield* this.getAgentsSkills();
        const local = yield* this.scanLocalSkills();
        const plugin = yield* this.getPluginSkills();
        return { builtin, global, agents, local, plugin };
      }.bind(this),
    );
  }

  loadSkill(skillName: string): Effect.Effect<SkillContent, Error> {
    return Effect.gen(
      function* (this: SkillsLive) {
        // Check memory cache first
        const loaded = yield* Ref.get(this.loadedSkills);
        const cached = loaded.get(skillName);
        if (cached) return cached;

        // Find skill path
        const allSkills = yield* this.listSkills();
        const metadata = allSkills.find((skill: SkillMetadata) => skill.name === skillName);
        if (!metadata) {
          return yield* Effect.fail(new Error(`Skill not found: ${skillName}`));
        }

        // Plugin skills carry their body in the manifest, not on disk. Serve it directly.
        if (metadata.source === "plugin") {
          const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
          const pluginSkills = Option.isSome(runtimeOption)
            ? yield* runtimeOption.value.listAllSkills()
            : [];
          const found = pluginSkills.find((skill) => skill.name === skillName);
          if (!found) return yield* Effect.fail(new Error(`Skill not found: ${skillName}`));
          const pluginContent: SkillContent = {
            metadata,
            core: found.content,
            sections: new Map(),
          };
          yield* Ref.update(this.loadedSkills, (map) => new Map(map).set(skillName, pluginContent));
          return pluginContent;
        }

        const skillPath = metadata.path;
        const skillMdPath = path.join(skillPath, "SKILL.md");

        // Parse SKILL.md
        const content = yield* Effect.tryPromise({
          try: () => fs.readFile(skillMdPath, "utf-8"),
          catch: toError,
        });
        const parsed = matter(content);

        const skillContent: SkillContent = {
          metadata,
          core: parsed.content, // The markdown body
          sections: new Map(), // Loaded on demand (Level 3)
        };

        // Cache in memory
        yield* Ref.update(this.loadedSkills, (map) => new Map(map).set(skillName, skillContent));

        return skillContent;
      }.bind(this),
    );
  }

  loadSkillSection(skillName: string, sectionName: string): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: SkillsLive) {
        const skill = yield* this.loadSkill(skillName);

        // Security check: ensure sectionName doesn't escape the skill directory
        // 1. Normalize the path to resolve any . or .. segments
        // 2. Resolve the full path
        // 3. Verify the resolved path is within the skill directory
        const normalizedSection = path.normalize(sectionName);
        const sectionPath = path.resolve(skill.metadata.path, normalizedSection);
        const skillDir = path.resolve(skill.metadata.path);

        // Ensure the resolved path is within the skill directory (prevent path traversal)
        if (!sectionPath.startsWith(skillDir + path.sep) && sectionPath !== skillDir) {
          return yield* Effect.fail(
            new Error(`Invalid section path: ${sectionName} - path traversal not allowed`),
          );
        }

        // Only allow specific file extensions for safety
        const allowedExtensions = [".md", ".txt", ".json", ".yaml", ".yml"];
        const ext = path.extname(sectionPath).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
          return yield* Effect.fail(
            new Error(
              `Invalid section file type: ${ext}. Allowed: ${allowedExtensions.join(", ")}`,
            ),
          );
        }

        // Verify file exists
        const exists = yield* Effect.tryPromise(async () => {
          try {
            await fs.access(sectionPath);
            return true;
          } catch {
            return false;
          }
        });

        if (!exists) {
          return yield* Effect.fail(
            new Error(`Section not found: ${sectionName} in skill ${skillName}`),
          );
        }

        return yield* Effect.tryPromise({
          try: () => fs.readFile(sectionPath, "utf-8"),
          catch: toError,
        });
      }.bind(this),
    );
  }

  private getGlobalSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    const globalSkillsDir = getGlobalSkillsDirectory();
    return loadCachedIndex<SkillMetadata>({
      cachePath: this.globalCachePath,
      scan: scanMarkdownIndex({
        dir: globalSkillsDir,
        fileName: "SKILL.md",
        depth: 3,
        parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir, "global"),
      }),
    });
  }

  private getAgentsSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    const agentsSkillsDir = getAgentsSkillsDirectory();
    return scanMarkdownIndex({
      dir: agentsSkillsDir,
      fileName: "SKILL.md",
      depth: 3,
      parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir, "agents"),
    });
  }

  private scanLocalSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    const cwd = process.cwd();
    return scanMarkdownIndex({
      dir: cwd,
      fileName: "SKILL.md",
      depth: 4,
      dot: true,
      parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir, "local"),
    });
  }

  /**
   * Skills contributed by enabled plugins (global), as metadata. Their content lives in the plugin
   * manifest and is served by loadSkill, so there is no filesystem path. Fail-open: an absent
   * runtime contributes nothing.
   */
  private getPluginSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    return Effect.gen(function* () {
      const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
      if (Option.isNone(runtimeOption)) return [];
      const skills = yield* runtimeOption.value.listAllSkills();
      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: "",
        source: "plugin" as const,
      }));
    });
  }

  private getBuiltinSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    return Effect.gen(
      function* (this: SkillsLive) {
        const builtinDir = getBuiltinSkillsDirectory();
        if (!builtinDir) {
          // No built-in skills directory found
          return [];
        }

        // Scan built-in skills directory (depth 2 is enough for skills/skill-name/SKILL.md)
        return yield* scanMarkdownIndex({
          dir: builtinDir,
          fileName: "SKILL.md",
          depth: 2,
          parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir, "builtin"),
        });
      }.bind(this),
    );
  }
}

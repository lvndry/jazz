
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import matter from "gray-matter";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "../utils/markdown-index.js";
import {
  getBuiltinSkillsDirectory,
  getGlobalSkillsDirectory,
} from "../utils/runtime-detection.js";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly path: string;
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
    sectionName: string
  ) => Effect.Effect<string, Error>;
}

export const SkillServiceTag = Context.GenericTag<SkillService>("SkillService");

function parseSkillFrontmatter(data: Record<string, unknown>, skillPath: string): SkillMetadata | null {
  const name = data["name"];
  const description = data["description"];

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  return {
    name,
    description,
    path: skillPath,
  };
}

/**
 * Implementation of SkillService
 */
export class SkillsLive implements SkillService {
  private constructor(
    private readonly globalCachePath: string,
    private readonly loadedSkills: Ref.Ref<Map<string, SkillContent>>
  ) { }

  public static readonly layer = Layer.effect(
    SkillServiceTag,
    Effect.gen(function* () {
      const homeDir = os.homedir();
      const globalCachePath = path.join(homeDir, ".jazz", "global-skills-index.json");
      const loadedSkills = yield* Ref.make(new Map<string, SkillContent>());

      return new SkillsLive(globalCachePath, loadedSkills);
    })
  );

  listSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    return Effect.gen(function* (this: SkillsLive) {
      // 1. Get Built-in Skills (shipped with Jazz)
      const builtinSkills = yield* this.getBuiltinSkills();

      // 2. Get Global Skills (Cached, medium priority - ~/.jazz/skills)
      const globalSkills = yield* this.getGlobalSkills();

      // 3. Get Local Skills (Fresh scan, highest priority - cwd)
      const localSkills = yield* this.scanLocalSkills();

      // 4. Merge (Local > Global > Built-in by name)
      return mergeByName(builtinSkills, globalSkills, localSkills);
    }.bind(this));
  }

  loadSkill(skillName: string): Effect.Effect<SkillContent, Error> {
    return Effect.gen(function* (this: SkillsLive) {
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

      const skillPath = metadata.path;
      const skillMdPath = path.join(skillPath, "SKILL.md");

      // Parse SKILL.md
      const content = yield* Effect.tryPromise(() => fs.readFile(skillMdPath, "utf-8"));
      const parsed = matter(content);

      const skillContent: SkillContent = {
        metadata,
        core: parsed.content, // The markdown body
        sections: new Map(), // Loaded on demand (Level 3)
      };

      // Cache in memory
      yield* Ref.update(this.loadedSkills, (map) =>
        new Map(map).set(skillName, skillContent)
      );

      return skillContent;
    }.bind(this));
  }

  loadSkillSection(skillName: string, sectionName: string): Effect.Effect<string, Error> {
    return Effect.gen(function* (this: SkillsLive) {
      const skill = yield* this.loadSkill(skillName);

      // Security check: ensure sectionName doesn't escape directory
      const safeSectionName = path.normalize(sectionName).replace(/^(\.\.(\/|\\|$))+/, '');
      const sectionPath = path.join(skill.metadata.path, safeSectionName);

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
        return yield* Effect.fail(new Error(`Section not found: ${sectionName} in skill ${skillName}`));
      }

      return yield* Effect.tryPromise(() => fs.readFile(sectionPath, "utf-8"));
    }.bind(this));
  }

  private getGlobalSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    const globalSkillsDir = getGlobalSkillsDirectory();
    return loadCachedIndex<SkillMetadata>({
      cachePath: this.globalCachePath,
      scan: scanMarkdownIndex({
        dir: globalSkillsDir,
        fileName: "SKILL.md",
        depth: 3,
        parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir),
      }),
    });
  }

  private scanLocalSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    const cwd = process.cwd();
    return scanMarkdownIndex({
      dir: cwd,
      fileName: "SKILL.md",
      depth: 4,
      parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir),
    });
  }

  private getBuiltinSkills(): Effect.Effect<readonly SkillMetadata[], Error> {
    return Effect.gen(function* (this: SkillsLive) {
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
        parse: (data, definitionDir) => parseSkillFrontmatter(data, definitionDir),
      });
    }.bind(this));
  }
}

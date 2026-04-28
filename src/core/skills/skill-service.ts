import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import matter from "gray-matter";
import { loadCachedIndex, mergeByName, scanMarkdownIndex } from "../utils/markdown-index.js";
import {
  getAgentsSkillsDirectory,
  getBuiltinSkillsDirectory,
  getGlobalSkillsDirectory,
} from "../utils/runtime-detection.js";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: "builtin" | "global" | "agents" | "local";
  /**
   * Optional one-line summary (≤ ~80 chars).
   * Rendered in the system-prompt skill index; the full `description` is only
   * loaded JIT via `find_skills` or when a trigger matches. When absent,
   * `getSkillIndexLine()` truncates `description` as a fallback.
   */
  readonly tagline?: string;
  /**
   * Optional list of keyword triggers. If any trigger appears in the user's
   * message (case-insensitive substring match), the skill's full description
   * is auto-injected into the system prompt for that turn.
   */
  readonly triggers?: readonly string[];
}

/**
 * Render the per-skill line shown in the system-prompt index.
 *
 * Prefers `tagline` (author-provided, curated). Falls back to the first
 * sentence or first 80 chars of `description` so legacy skills still work.
 */
export function getSkillIndexLine(metadata: SkillMetadata): string {
  if (metadata.tagline && metadata.tagline.trim().length > 0) {
    return metadata.tagline.trim();
  }
  const desc = metadata.description.trim();
  if (desc.length === 0) return metadata.name;
  // Take first sentence if it's short enough; otherwise truncate.
  const firstSentenceMatch = desc.match(/^[^.!?]{1,80}[.!?]/);
  if (firstSentenceMatch) return firstSentenceMatch[0];
  return desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
}

/**
 * Rank skills by relevance to a query.
 *
 * Deterministic keyword scoring (no embeddings, no LLM call):
 * - exact name match → +100
 * - name substring match → +20
 * - trigger word-boundary match → +10
 * - tagline word-boundary match → +5
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

    if (skill.triggers && skill.triggers.some((t) => matchesTriggerWord(t.toLowerCase(), q))) {
      score += 10;
    }
    if (skill.tagline && matchesTriggerWord(skill.tagline.toLowerCase(), q)) score += 5;
    if (matchesTriggerWord(skill.description.toLowerCase(), q)) score += 2;

    if (score > 0) scored.push({ skill, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });

  return scored.slice(0, limit).map((entry) => entry.skill);
}

/**
 * Return the names of skills whose triggers match the given input.
 *
 * A trigger matches when the trigger string appears as a case-insensitive
 * whole-word substring of the input. Whole-word match (rather than raw
 * substring) avoids accidental matches like "email" triggering on "emailing
 * the wrong person" — though the user actually said "emailing", which is
 * still a legitimate signal. So we use word-boundary anchoring on the
 * trigger's start and end. Multiword triggers ("inbox triage") match
 * phrasewise.
 *
 * Pure, deterministic, no LLM overhead.
 */
export function matchSkillTriggers(
  input: string,
  skills: readonly SkillMetadata[],
): readonly string[] {
  if (!input || skills.length === 0) return [];
  const lowered = input.toLowerCase();
  const matched: string[] = [];

  for (const skill of skills) {
    const triggers = skill.triggers;
    if (!triggers || triggers.length === 0) continue;
    for (const trigger of triggers) {
      const t = trigger.trim().toLowerCase();
      if (t.length === 0) continue;
      if (matchesTriggerWord(lowered, t)) {
        matched.push(skill.name);
        break; // one trigger match per skill is enough
      }
    }
  }

  return matched;
}

/**
 * Whole-word substring match for a trigger inside an input string.
 *
 * Uses lookaround for boundaries because `\b` only fires between word and
 * non-word characters — triggers like "c++" or "node-fetch" need to match
 * even though `+` and `-` are non-word, and naive `\b...\b` would fail.
 *
 * Both inputs assumed lowercase.
 */
function matchesTriggerWord(input: string, trigger: string): boolean {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?<![A-Za-z0-9_]) and (?![A-Za-z0-9_]) act as a "not adjacent to an
  // identifier char" boundary. Works whether the trigger ends with a word
  // char or not — start-of-string and whitespace both satisfy the lookaround.
  const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
  return re.test(input);
}

export interface SkillsBySource {
  readonly builtin: readonly SkillMetadata[];
  readonly global: readonly SkillMetadata[];
  readonly agents: readonly SkillMetadata[];
  readonly local: readonly SkillMetadata[];
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

  const tagline = typeof data["tagline"] === "string" ? data["tagline"].trim() : "";
  const rawTriggers = data["triggers"];
  const triggers = Array.isArray(rawTriggers)
    ? rawTriggers.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];

  return {
    name,
    description,
    path: skillPath,
    source,
    ...(tagline.length > 0 && { tagline }),
    ...(triggers.length > 0 && { triggers }),
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

        // 5. Merge (Local > Agents > Global > Built-in by name)
        const merged = mergeByName(builtinSkills, globalSkills, agentsSkills, localSkills);

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
        return { builtin, global, agents, local };
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

        const skillPath = metadata.path;
        const skillMdPath = path.join(skillPath, "SKILL.md");

        // Parse SKILL.md
        const content = yield* Effect.tryPromise({
          try: () => fs.readFile(skillMdPath, "utf-8"),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
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
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
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

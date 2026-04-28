import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  scoreSkillsForQuery,
  SkillServiceTag,
  type SkillMetadata,
  type SkillService,
} from "@/core/skills/skill-service";

/**
 * Create skill tools with skill_name constrained to discovered skill names.
 */
export function createSkillTools(skillNames: readonly string[]): Tool<SkillService>[] {
  const skillNameSchema =
    skillNames.length > 0 ? z.enum(skillNames as unknown as [string, ...string[]]) : z.string();

  return [
    {
      name: "find_skills",
      description:
        "Search the skill catalog by query and return the top matches with their full descriptions. Use this when the system-prompt skill index doesn't have enough detail to decide which skill to load.",
      parameters: z.object({
        query: z.string().min(1).describe("Free-text query (e.g. 'email triage', 'commit message')"),
        limit: z
          .number()
          .int()
          .positive()
          .max(10)
          .optional()
          .describe("Max number of matches to return (default 5)"),
      }),
      hidden: false,
      riskLevel: "read-only",
      createSummary: undefined,
      execute: (args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const query = String(args["query"] ?? "").trim();
          const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
          const skillService = yield* SkillServiceTag;

          if (query.length === 0) {
            return {
              success: false,
              result: null,
              error: "find_skills requires a non-empty query",
            };
          }

          const skills = yield* skillService
            .listSkills()
            .pipe(Effect.catchAll(() => Effect.succeed([] as readonly SkillMetadata[])));

          const ranked = scoreSkillsForQuery(query, skills, limit);
          if (ranked.length === 0) {
            return {
              success: true,
              result: `No skills matched query "${query}". Use load_skill if you know the exact name.`,
            };
          }

          const lines = ranked
            .map((s) => `- ${s.name}: ${s.description}`)
            .join("\n");
          return {
            success: true,
            result: `Top ${ranked.length} skill(s) matching "${query}":\n${lines}\n\nLoad one with load_skill.`,
          };
        }),
    },
    {
      name: "load_skill",
      description: "Load a skill's full instructions by name.",
      parameters: z.object({
        skill_name: skillNameSchema.describe("Skill name to load"),
      }),
      hidden: false,
      riskLevel: "read-only",
      createSummary: undefined,
      execute: (args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const skillName = String(args["skill_name"]);
          const skillService = yield* SkillServiceTag;

          try {
            const skill = yield* skillService.loadSkill(skillName);
            return {
              success: true,
              result: `Loaded skill: ${skill.metadata.name}\n\n${skill.core}`,
            };
          } catch (error) {
            return {
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    },
    {
      name: "load_skill_section",
      description: "Load a supplementary file referenced in a skill's instructions.",
      parameters: z.object({
        skill_name: skillNameSchema.describe("Skill name"),
        section_name: z.string().describe("Section name/path to load"),
      }),
      hidden: false,
      riskLevel: "read-only",
      createSummary: undefined,
      execute: (args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const skillName = String(args["skill_name"]);
          const sectionName = String(args["section_name"]);
          const skillService = yield* SkillServiceTag;

          try {
            const content = yield* skillService.loadSkillSection(skillName, sectionName);
            return {
              success: true,
              result: `Loaded section '${sectionName}' from skill '${skillName}':\n\n${content}`,
            };
          } catch (error) {
            return {
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    },
  ];
}

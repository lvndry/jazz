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
      disclosure: "context",
      description:
        "Search the skill catalog by keyword and return the top matches with their full descriptions. Matching is keyword, not semantic. Use this when the skill index in the system prompt is not enough to decide which skill to load, then call load_skill.",
      parameters: z.object({
        query: z
          .string()
          .min(1)
          .describe("What you are looking for, for example 'email triage' or 'commit message'."),
        limit: z
          .number()
          .int()
          .positive()
          .max(10)
          .optional()
          .describe("Maximum number of matches to return. Default 5."),
      }),
      hidden: false,
      riskLevel: "read-only",
      createSummary: undefined,
      execute: (args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const queryArg = args["query"];
          const query = (typeof queryArg === "string" ? queryArg : "").trim();
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

          const lines = ranked.map((s) => `- ${s.name}: ${s.description}`).join("\n");
          return {
            success: true,
            result: `Top ${ranked.length} skill(s) matching "${query}":\n${lines}\n\nLoad one with load_skill.`,
          };
        }),
    },
    {
      name: "load_skill",
      disclosure: "context",
      description:
        "Load a skill's full instruction body by name (the markdown after the frontmatter). Load only when the index or find_skills names a match for the current task. Do not preload every skill.",
      parameters: z.object({
        skill_name: skillNameSchema.describe("Name of the skill to load."),
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
      disclosure: "context",
      description:
        "Load a supplementary file referenced in a skill's instructions, for example references/foo.md. Call this only after load_skill. Allowed extensions: .md, .txt, .json, .yaml, .yml.",
      parameters: z.object({
        skill_name: skillNameSchema.describe("Name of the skill that referenced this file."),
        section_name: z
          .string()
          .describe("Path of the supplementary file, for example references/foo.md."),
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

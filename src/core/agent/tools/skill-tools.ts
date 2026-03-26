import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";

/**
 * Create skill tools with skill_name constrained to discovered skill names.
 */
export function createSkillTools(skillNames: readonly string[]): Tool<SkillService>[] {
  const skillNameSchema =
    skillNames.length > 0 ? z.enum(skillNames as unknown as [string, ...string[]]) : z.string();

  return [
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


import type { Tool } from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";
import { Effect } from "effect";
import { z } from "zod";

/**
 * Tools for interacting with Agent Skills
 */
export const skillTools: Tool<SkillService>[] = [
    {
        name: "load_skill",
        description: "Load the full instructions (SKILL.md) for a specific skill. Use this when you decide a skill is relevant to the user's request. This is the first step in using a skill (Level 2 Progressive Disclosure).",
        parameters: z.object({
            skill_name: z.string().describe("The name of the skill to load (e.g. 'release-notes')")
        }),
        hidden: false,
        createSummary: undefined,
        execute: (args: Record<string, unknown>) => Effect.gen(function* () {
            const skillName = String(args["skill_name"]);
            const skillService = yield* SkillServiceTag;

            try {
                const skill = yield* skillService.loadSkill(skillName);
                return {
                    success: true,
                    result: `Loaded skill: ${skill.metadata.name}\n\n${skill.core}`
                };
            } catch (error) {
                return {
                    success: false,
                    result: null,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        })
    },
    {
        name: "load_skill_section",
        description: "Load a specific section or file referenced by a skill. Use this to get detailed instructions or reference material mentioned in SKILL.md (Level 3 Progressive Disclosure).",
        parameters: z.object({
            skill_name: z.string().describe("The name of the skill"),
            section_name: z.string().describe("The name/path of the section to load (as referenced in SKILL.md)")
        }),
        hidden: false,
        createSummary: undefined,
        execute: (args: Record<string, unknown>) => Effect.gen(function* () {
            const skillName = String(args["skill_name"]);
            const sectionName = String(args["section_name"]);
            const skillService = yield* SkillServiceTag;

            try {
                const content = yield* skillService.loadSkillSection(skillName, sectionName);
                return {
                    success: true,
                    result: `Loaded section '${sectionName}' from skill '${skillName}':\n\n${content}`
                };
            } catch (error) {
                return {
                    success: false,
                    result: null,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        })
    }
];

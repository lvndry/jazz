import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@/core/skills/skill-service";

/**
 * Create skill tools with skill_name constrained to discovered skill names.
 */
export function createSkillTools(skillNames: readonly string[]): Tool<SkillService>[] {
    const skillNameSchema = skillNames.length > 0
        ? z.enum(skillNames as unknown as [string, ...string[]])
        : z.string();

    return [
        {
            name: "load_skill",
            description: "Load the full instructions for a specific skill by name. ALWAYS use this tool when the user's request matches a skill's domain (e.g., email, calendar, notes, documentation, commit messages). Loading a skill gives you the complete workflow, best practices, and tool-chaining instructions for that domain. Prefer skills over ad-hoc tool usage whenever a matching skill exists.",
            parameters: z.object({
                skill_name: skillNameSchema.describe("The exact name of the skill to load, as shown in the available skills list (e.g., 'commit-message', 'email', 'calendar', 'deep-research')")
            }),
            hidden: false,
            riskLevel: "read-only",
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
            description: "Load a specific section or supplementary file referenced within a skill's instructions. Use this after loading a skill with load_skill when the skill's instructions reference additional files (e.g., reference.md, examples.md, or template files) that you need to complete the task.",
            parameters: z.object({
                skill_name: skillNameSchema.describe("The name of the skill"),
                section_name: z.string().describe("The name/path of the section to load (as referenced in SKILL.md)")
            }),
            hidden: false,
            riskLevel: "read-only",
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
}

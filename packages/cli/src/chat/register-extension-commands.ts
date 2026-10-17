import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
import {
  getSkillIndexLine,
  SkillServiceTag,
  type SkillService,
} from "@jazz/core/skills/skill-service";
import { Effect, Option } from "effect";
import { setPluginCommands, setSkillCommands } from "./commands/constants";

/**
 * Register skills and the agent's enabled plugins' commands as slash commands, so they autocomplete
 * and run like built-ins. Called at chat start and again whenever plugins are turned on or off.
 * Non-fatal: a source that cannot be listed is simply left out of the menu.
 */
export function registerExtensionCommands(
  agentId: string,
): Effect.Effect<void, never, SkillService> {
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const skillService = yield* SkillServiceTag;
      const skills = yield* skillService.listSkills();
      setSkillCommands(
        skills.map((skill) => ({ name: skill.name, description: getSkillIndexLine(skill) })),
      );
    }).pipe(Effect.catch(() => Effect.void));

    const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
    if (Option.isNone(runtimeOption)) {
      setPluginCommands([]);
      return;
    }
    const commands = yield* runtimeOption.value.listAgentCommands(agentId);
    setPluginCommands(
      commands.map((command) => ({ name: command.name, description: command.description })),
    );
  });
}

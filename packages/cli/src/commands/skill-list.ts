/**
 * `jazz skill list`: the skills an agent can load, grouped by where they come
 * from, or one JSON document with `--json`.
 */

import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  SkillServiceTag,
  type SkillMetadata,
  type SkillService,
} from "@jazz/core/skills/skill-service";
import { Effect } from "effect";
import * as fmt from "@/cli/utils/list-format";

/** How each source is headed in the human listing, in display order. */
const SOURCE_TITLES: readonly (readonly [SkillMetadata["source"], string])[] = [
  ["local", "Project"],
  ["agents", "~/.agents/skills"],
  ["global", "Global (~/.jazz/skills)"],
  ["plugin", "Plugins"],
  ["builtin", "Built-in"],
];

export function listSkillsCommand(
  options: { readonly json?: boolean } = {},
): Effect.Effect<void, Error, SkillService | TerminalService> {
  return Effect.gen(function* () {
    const skillService = yield* SkillServiceTag;
    const terminal = yield* TerminalServiceTag;
    const skills = yield* skillService.listSkills();

    if (options.json === true) {
      const document = {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          ...(skill.path.length > 0 ? { path: skill.path } : {}),
        })),
      };
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
      return;
    }

    if (skills.length === 0) {
      yield* terminal.info("No skills installed. Browse the library with: jazz skill browse");
      return;
    }

    yield* terminal.log(fmt.heading("Skills"));
    for (const [source, title] of SOURCE_TITLES) {
      const inSource = skills.filter((skill) => skill.source === source);
      if (inSource.length === 0) {
        continue;
      }
      yield* terminal.log(fmt.section(title, inSource.length, "skill"));
      for (const skill of inSource) {
        yield* terminal.log(fmt.itemWithDesc(skill.name, skill.description));
      }
      yield* terminal.log(fmt.blank());
    }
    yield* terminal.log(fmt.footer(`Total: ${skills.length} skill(s)`));
  });
}

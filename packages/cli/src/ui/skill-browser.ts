/**
 * Shared skill-browser data shaping for the fullscreen and Ink terminals.
 * Search operates only on the already discovered metadata; opening a skill
 * never reads or executes its instruction file.
 */

import type { SkillMetadata } from "@jazz/core/skills/skill-service";
import { wrapTerminalCells } from "./fullscreen/terminal-cells";

/** Flatten metadata to one safe terminal line, including untrusted frontmatter. */
export function skillLine(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Match every space-delimited term against name, source, or description. */
export function filterSkills(
  skills: readonly SkillMetadata[],
  query: string,
): readonly SkillMetadata[] {
  const terms = skillLine(query).toLowerCase().split(" ").filter(Boolean);
  if (terms.length === 0) return skills;
  return skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.source} ${skill.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface SkillDetailRow {
  readonly text: string;
  readonly heading: boolean;
}

/** Wrap the selected skill's metadata to physical terminal rows. */
export function skillDetailRows(skill: SkillMetadata, width: number): readonly SkillDetailRow[] {
  const rows: SkillDetailRow[] = [];
  const contentWidth = Math.max(1, width - 4);
  const sections = [
    ["Source", skill.source],
    ["Description", skillLine(skill.description) || "No description provided."],
    ...(skill.path === "" ? [] : [["Location", skillLine(skill.path)]]),
  ] as const;
  for (const [heading, value] of sections) {
    if (rows.length > 0) rows.push({ text: "", heading: false });
    rows.push({ text: heading, heading: true });
    for (const text of wrapTerminalCells(value, contentWidth)) {
      rows.push({ text, heading: false });
    }
  }
  return rows;
}

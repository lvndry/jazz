/** Static marketplace index for repository skills discovered under `skills/<name>/SKILL.md`. */

import { getSkillEntries, toSkillIndexEntry } from "../../lib/library";

export async function GET(): Promise<Response> {
  const skills = await getSkillEntries();
  return new Response(
    JSON.stringify({ version: 1, skills: skills.map(toSkillIndexEntry) }, null, 2),
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

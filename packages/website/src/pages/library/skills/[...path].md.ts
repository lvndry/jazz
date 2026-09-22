/** Serve one repository skill as plain markdown, preserving its frontmatter exactly. */

import { getSkillEntries, readSkillSource, type SkillEntry } from "../../../lib/library";

export async function getStaticPaths() {
  const entries = await getSkillEntries();
  return entries.map((entry) => ({
    params: { path: entry.id },
    props: { entry },
  }));
}

export async function GET(context: { props: { entry: SkillEntry } }): Promise<Response> {
  return new Response(await readSkillSource(context.props.entry), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

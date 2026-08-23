import { getCollection } from "astro:content";

import type { DocsEntry } from "../../lib/docs";

export async function getStaticPaths() {
  const entries = await getCollection("docs");
  return entries.map((entry) => ({
    params: { id: entry.id },
    props: { entry },
  }));
}

export function GET(context: { props: { entry: DocsEntry } }): Response {
  return new Response(context.props.entry.body ?? "", {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

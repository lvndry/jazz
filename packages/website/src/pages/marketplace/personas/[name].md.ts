import { getMarketplaceEntries, type MarketplaceEntry } from "../../../lib/marketplace";

export async function getStaticPaths() {
  const entries = await getMarketplaceEntries();
  return entries.map((entry) => ({
    params: { name: entry.data.name },
    props: { entry },
  }));
}

/** The raw `persona.md`, exactly as `jazz persona install` parses it. */
export function GET(context: { props: { entry: MarketplaceEntry } }): Response {
  const { entry } = context.props;
  const { name, description, tone, style, author, tags } = entry.data;
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...(tone ? [`tone: ${tone}`] : []),
    ...(style ? [`style: ${style}`] : []),
    ...(author ? [`author: ${author}`] : []),
    ...(tags.length > 0 ? [`tags: [${tags.join(", ")}]`] : []),
    "---",
    "",
  ].join("\n");

  return new Response(`${frontmatter}${entry.body ?? ""}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

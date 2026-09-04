import { getCollection, type CollectionEntry } from "astro:content";

export type MarketplaceEntry = CollectionEntry<"marketplace">;

/**
 * One persona as the CLI's `personas.json` index describes it: metadata plus the
 * URL of the raw `persona.md`. The prompt body is deliberately not inlined —
 * browsing a catalog should not download every prompt in it.
 */
export interface MarketplaceIndexEntry {
  name: string;
  description: string;
  tone?: string;
  style?: string;
  author?: string;
  tags?: string[];
  url: string;
}

/** Path of the raw markdown for a persona, relative to the site root. */
export function rawPersonaPath(name: string): string {
  return `/marketplace/personas/${name}.md`;
}

/** Path of a persona's page on the site. */
export function personaPath(name: string): string {
  return `/marketplace/${name}`;
}

/** Every published persona, sorted by name. */
export async function getMarketplaceEntries(): Promise<MarketplaceEntry[]> {
  const entries = await getCollection("marketplace");
  return entries.sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export function toIndexEntry(entry: MarketplaceEntry): MarketplaceIndexEntry {
  const { name, description, tone, style, author, tags } = entry.data;
  return {
    name,
    description,
    ...(tone ? { tone } : {}),
    ...(style ? { style } : {}),
    ...(author ? { author } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    url: rawPersonaPath(name),
  };
}

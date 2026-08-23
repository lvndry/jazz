import type { CollectionEntry } from "astro:content";

export const REPO_URL = "https://github.com/lvndry/jazz";

/** Section order mirrors the section list in docs/index.md. */
export const SECTIONS: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: "guide", label: "Guide" },
  { dir: "surfaces", label: "Surfaces" },
  { dir: "concepts", label: "Concepts" },
  { dir: "cookbook", label: "Cookbook" },
  { dir: "integrations", label: "Integrations" },
  { dir: "reference", label: "Reference" },
  { dir: "internals", label: "Internals" },
  { dir: "design", label: "Design" },
];

export type DocsEntry = CollectionEntry<"docs">;

/** "guide/quick-start" → "guide/quick-start"; "guide/index" → "guide"; "index" → "". */
export function routeSlugFor(id: string): string {
  if (id === "index") return "";
  return id.endsWith("/index") ? id.slice(0, -"/index".length) : id;
}

export function routeFor(id: string): string {
  const slug = routeSlugFor(id);
  return slug === "" ? "/docs" : `/docs/${slug}`;
}

const humanize = (slug: string): string =>
  slug.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

export function titleOf(entry: DocsEntry): string {
  const fromFrontmatter = (entry.data as Record<string, unknown>)["title"];
  if (typeof fromFrontmatter === "string" && fromFrontmatter.length > 0) return fromFrontmatter;
  const heading = entry.body?.match(/^#\s+(.+)$/m)?.[1];
  if (heading) return heading.replace(/\[(.+?)\]\([^)]*\)/g, "$1").trim();
  const id = routeSlugFor(entry.id);
  return humanize(id.split("/").pop() ?? "Documentation");
}

export interface SidebarItem {
  title: string;
  route: string;
  id: string;
}

export interface SidebarSection {
  label: string;
  route: string | undefined;
  items: SidebarItem[];
}

/**
 * Sections in the order docs/index.md lists them; within a section the
 * index page leads and the rest sort alphabetically by route. Nested
 * folders (e.g. guide/use-cases) stay inside their top-level section.
 */
export function buildSidebar(entries: DocsEntry[]): SidebarSection[] {
  const bySection = new Map<string, DocsEntry[]>();
  for (const entry of entries) {
    if (entry.id === "index") continue;
    const section = entry.id.split("/")[0] ?? "";
    const bucket = bySection.get(section) ?? [];
    bucket.push(entry);
    bySection.set(section, bucket);
  }

  const knownDirs = new Set(SECTIONS.map((section) => section.dir));
  const extraDirs = [...bySection.keys()].filter((dir) => !knownDirs.has(dir)).sort();
  const ordered = [...SECTIONS, ...extraDirs.map((dir) => ({ dir, label: humanize(dir) }))];

  const sections: SidebarSection[] = [];
  for (const { dir, label } of ordered) {
    const bucket = bySection.get(dir);
    if (!bucket) continue;
    const indexEntry = bucket.find((entry) => entry.id === `${dir}/index`);
    const rest = bucket
      .filter((entry) => entry.id !== `${dir}/index`)
      .sort((a, b) => a.id.localeCompare(b.id));
    sections.push({
      label,
      route: indexEntry ? routeFor(indexEntry.id) : undefined,
      items: rest.map((entry) => ({
        title: titleOf(entry),
        route: routeFor(entry.id),
        id: entry.id,
      })),
    });
  }
  return sections;
}

export interface PrevNext {
  prev: SidebarItem | undefined;
  next: SidebarItem | undefined;
}

export function prevNextFor(sections: SidebarSection[], id: string): PrevNext {
  const flat = sections.flatMap((section) => section.items);
  const index = flat.findIndex((item) => item.id === id);
  if (index < 0) return { prev: undefined, next: undefined };
  return { prev: flat[index - 1], next: flat[index + 1] };
}

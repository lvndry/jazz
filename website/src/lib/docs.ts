import type { CollectionEntry } from "astro:content";

export const REPO_URL = "https://github.com/lvndry/jazz";

/** Section order mirrors the section list in docs/index.md. */
export const SECTIONS: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: "guide", label: "Guide" },
  { dir: "surfaces", label: "Where it runs" },
  { dir: "integrations", label: "Integrations" },
  { dir: "concepts", label: "Concepts" },
  { dir: "cookbook", label: "Cookbook" },
  { dir: "examples", label: "Examples" },
  { dir: "reference", label: "Reference" },
  { dir: "internals", label: "Internals" },
  { dir: "design", label: "Design" },
];

const sectionKeyFor = (id: string): string => id.split("/")[0] ?? "";

export type DocsEntry = CollectionEntry<"docs">;

/**
 * Within a section, these ids come first, in this order — mirroring how
 * docs/index.md presents each section. Anything unlisted follows
 * alphabetically.
 */
const PINNED_ORDER: Record<string, string[]> = {
  guide: ["guide/quick-start", "guide/creating-agents", "guide/airgapped", "guide/observability"],
  surfaces: [
    "surfaces/headless",
    "surfaces/chat-platforms",
    "surfaces/ci-cd",
    "surfaces/scheduled",
  ],
  concepts: [
    "concepts/agents",
    "concepts/personas",
    "concepts/skills",
    "concepts/tools",
    "concepts/workflows",
    "concepts/scheduling",
  ],
  reference: [
    "reference/cli",
    "reference/configuration",
    "reference/tools",
    "reference/workflow-frontmatter",
  ],
  cookbook: [
    "cookbook/inbox-triage",
    "cookbook/pr-watchdog",
    "cookbook/research-digest",
    "cookbook/competitor-watch",
    "cookbook/codebase-tech-debt-radar",
    "cookbook/ci-pr-reviewer",
    "cookbook/release-notes-draft",
  ],
  internals: [
    "internals/agent-loop",
    "internals/context-management",
    "internals/tools-and-approval",
    "internals/subagents",
    "internals/skills-loading",
    "internals/providers-and-models",
    "internals/evals",
    "internals/design-decisions",
    "internals/code-map",
  ],
};

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
  if (heading)
    return heading
      .replace(/\[(.+?)\]\([^)]*\)/g, "$1")
      .replace(/^Use Case:\s*/i, "")
      .trim();
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
    const section = sectionKeyFor(entry.id);
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
    const indexEntry = bucket.find((entry) => entry.id === dir || entry.id === `${dir}/index`);
    const pinned = PINNED_ORDER[dir] ?? [];
    const rank = (id: string): number => {
      const position = pinned.indexOf(id);
      return position === -1 ? pinned.length : position;
    };
    const rest = bucket
      .filter((entry) => entry !== indexEntry)
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
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

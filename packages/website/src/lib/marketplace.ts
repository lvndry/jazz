/**
 * The marketplace as the CLI sees it: two collections, personas and workflows,
 * each published as a JSON index plus one raw markdown file per entry. The
 * index carries metadata only — browsing a catalog should not download every
 * prompt in it — and the raw file is what `jazz persona install` and
 * `jazz workflow install` parse. See packages/adapters/src/marketplace-catalog.ts
 * for the consumer.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { getCollection, type CollectionEntry } from "astro:content";

export type PersonaEntry = CollectionEntry<"personas">;
export type WorkflowEntry = CollectionEntry<"workflows">;

export interface PersonaIndexEntry {
  name: string;
  description: string;
  tone?: string;
  style?: string;
  author?: string;
  tags?: string[];
  url: string;
}

export interface WorkflowIndexEntry {
  name: string;
  description: string;
  schedule?: string;
  autoApprove?: boolean | "read-only" | "low-risk" | "high-risk";
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
  return `/marketplace/personas/${name}`;
}

/** Path of the raw markdown for a workflow, relative to the site root. */
export function rawWorkflowPath(name: string): string {
  return `/marketplace/workflows/${name}.md`;
}

/** Path of a workflow's page on the site. */
export function workflowPath(name: string): string {
  return `/marketplace/workflows/${name}`;
}

function byName<T extends { data: { name: string } }>(entries: T[]): T[] {
  return entries.sort((left, right) => left.data.name.localeCompare(right.data.name));
}

/** Every published persona, sorted by name. */
export async function getPersonaEntries(): Promise<PersonaEntry[]> {
  return byName(await getCollection("personas"));
}

/** Every published workflow, sorted by name. */
export async function getWorkflowEntries(): Promise<WorkflowEntry[]> {
  return byName(await getCollection("workflows"));
}

export function toPersonaIndexEntry(entry: PersonaEntry): PersonaIndexEntry {
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

export function toWorkflowIndexEntry(entry: WorkflowEntry): WorkflowIndexEntry {
  const { name, description, schedule, autoApprove, author, tags } = entry.data;
  return {
    name,
    description,
    ...(schedule ? { schedule } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    ...(author ? { author } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    url: rawWorkflowPath(name),
  };
}

/**
 * The WORKFLOW.md exactly as committed, frontmatter included. A workflow's
 * frontmatter is half of what gets installed, so the site serves the file
 * itself rather than re-serialising a subset of it. Paths from the glob loader
 * are relative to the Astro project root, which is where `astro build` runs.
 */
export async function readWorkflowSource(entry: WorkflowEntry): Promise<string> {
  if (entry.filePath === undefined) {
    throw new Error(`Workflow "${entry.data.name}" has no source file to serve`);
  }
  return readFile(resolve(entry.filePath), "utf8");
}

/**
 * A workflow's default frequency the way a reader wants it: the English reading
 * first, the cron it came from in parentheses, so nobody has to decode `0 17 * * 5`.
 */
export function describeFrequency(cron: string): string {
  const described = describeCronSchedule(cron);
  return described ? `${described} (${cron})` : cron;
}

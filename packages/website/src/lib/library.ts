/**
 * The website's marketplace catalog readers and route helpers.
 *
 * Personas and workflows come from Astro content collections. Skills are
 * discovered directly from repository-level `skills/<name>/SKILL.md` files so
 * their frontmatter and body can be served byte-for-byte. Reviewed plugins are
 * read from the generated catalog emitted before the Astro build. JSON indexes
 * carry metadata only; raw markdown and plugin manifests remain separate
 * routes for callers that need the complete definition.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { getCollection, type CollectionEntry } from "astro:content";

export type PersonaEntry = CollectionEntry<"personas">;
export type WorkflowEntry = CollectionEntry<"workflows">;

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
}

export interface PluginSecretEntry {
  name: string;
  env?: string;
  required: boolean;
  description: string;
}

export interface PluginEntry {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  hostApi: number;
  artifact: string;
  sha256: string;
  hooks: string[];
  policyHooks: string[];
  decisionProviders: string[];
  tools: Array<{ name: string; description: string; riskLevel: string; egress: boolean }>;
  commands: Array<{ name: string; description: string }>;
  personas: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
  lifecycleHooks: string[];
  network: { destinations: string[] };
  dataSent: string[];
  secrets: PluginSecretEntry[];
}

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

export interface SkillIndexEntry {
  name: string;
  description: string;
  url: string;
  page: string;
}

/** Path of the raw markdown for a persona, relative to the site root. */
export function rawPersonaPath(name: string): string {
  return `/library/personas/${name}.md`;
}

/** Path of a persona's page on the site. */
export function personaPath(name: string): string {
  return `/library/personas/${name}`;
}

/** Path of the raw markdown for a workflow, relative to the site root. */
export function rawWorkflowPath(name: string): string {
  return `/library/workflows/${name}.md`;
}

/** Path of a workflow's page on the site. */
export function workflowPath(name: string): string {
  return `/library/workflows/${name}`;
}

/** Path of a skill's rendered marketplace page. */
export function skillPath(id: string): string {
  return `/library/skills/${encodePath(id)}`;
}

/** Path of a skill's raw, frontmatter-preserving markdown source. */
export function rawSkillPath(id: string): string {
  return `/library/skills/${encodePath(id)}.md`;
}

/** Path of a reviewed plugin's marketplace page. */
export function pluginPath(id: string): string {
  return `/library/plugins/${encodePath(id)}`;
}

/** Path of a reviewed plugin's generated manifest. */
export function pluginManifestPath(id: string): string {
  return `/library/plugins/${encodePath(id)}.json`;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
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

const skillDirectoryCandidates = [
  resolve(process.cwd(), "skills"),
  resolve(process.cwd(), "../skills"),
  resolve(process.cwd(), "../../skills"),
] as const;
const pluginCatalogCandidates = [
  resolve(process.cwd(), ".build/plugin-catalog/plugins.json"),
  resolve(process.cwd(), "../.build/plugin-catalog/plugins.json"),
  resolve(process.cwd(), "../../.build/plugin-catalog/plugins.json"),
] as const;

let repositorySkillsDirectoryPromise: Promise<string> | undefined;

async function getRepositorySkillsDirectory(): Promise<string> {
  repositorySkillsDirectoryPromise ??= (async () => {
    for (const candidate of skillDirectoryCandidates) {
      try {
        await readdir(candidate);
        return candidate;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    throw new Error("Could not locate the repository skills directory");
  })();
  return repositorySkillsDirectoryPromise;
}

async function findSkillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(path)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function unquoteFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function readSkillMetadata(source: string, id: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error(`Skill "${id}" is missing YAML frontmatter`);

  const lines = match[1].split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const field = /^(name|description):(?:\s*(.*))?$/.exec(line);
    if (!field) continue;
    const key = field[1];
    const value = field[2] ?? "";
    if (key === "name" && value !== ">" && value !== "|") {
      name = unquoteFrontmatterValue(value);
      continue;
    }
    if (key !== "description") continue;
    if (value !== ">" && value !== "|") {
      description = unquoteFrontmatterValue(value);
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length && /^(?:\s+|$)/.test(lines[index + 1] ?? "")) {
      index += 1;
      block.push((lines[index] ?? "").trim());
    }
    description = value === ">" ? block.join(" ").trim() : block.join("\n").trim();
  }
  if (!name || !description)
    throw new Error(`Skill "${id}" needs name and description frontmatter`);
  return { name, description };
}

function skillIdForFile(filePath: string, repositorySkillsDirectory: string): string {
  const directory = relative(repositorySkillsDirectory, filePath).split(sep).slice(0, -1);
  if (
    directory.length === 0 ||
    directory.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error(`Skill path is not a safe marketplace identifier: ${filePath}`);
  }
  return directory.join("/");
}

let skillEntriesPromise: Promise<SkillEntry[]> | undefined;

/** Discover repository skills without rewriting their source or frontmatter. */
export async function getSkillEntries(): Promise<SkillEntry[]> {
  skillEntriesPromise ??= (async () => {
    const repositorySkillsDirectory = await getRepositorySkillsDirectory();
    const files = await findSkillFiles(repositorySkillsDirectory);
    const entries = await Promise.all(
      files.map(async (sourcePath) => {
        const id = skillIdForFile(sourcePath, repositorySkillsDirectory);
        const metadata = readSkillMetadata(await readFile(sourcePath, "utf8"), id);
        return { id, sourcePath, ...metadata };
      }),
    );
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  })();
  return skillEntriesPromise;
}

/** Read a skill exactly as committed, including its YAML frontmatter. */
export async function readSkillSource(entry: SkillEntry): Promise<string> {
  const repositorySkillsDirectory = await getRepositorySkillsDirectory();
  const sourcePath = resolve(entry.sourcePath);
  const relativePath = relative(repositorySkillsDirectory, sourcePath);
  if (
    basename(sourcePath) !== "SKILL.md" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new Error(`Skill "${entry.id}" is outside the repository skills root`);
  }
  return readFile(sourcePath, "utf8");
}

export function toSkillIndexEntry(entry: SkillEntry): SkillIndexEntry {
  return {
    name: entry.name,
    description: entry.description,
    url: rawSkillPath(entry.id),
    page: skillPath(entry.id),
  };
}

function catalogRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function catalogString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be a string`);
  }
  return value;
}

function catalogNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be a number`);
  }
  return value;
}

function catalogBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be a boolean`);
  }
  return value;
}

function catalogStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be an array of strings`);
  }
  return [...value];
}

function catalogNamedDescriptions(
  value: unknown,
  label: string,
): Array<{ name: string; description: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid reviewed plugin catalog: ${label} must be an array`);
  }
  return value.map((item, index) => {
    const record = catalogRecord(item, `${label}[${index}]`);
    return {
      name: catalogString(record.name, `${label}[${index}].name`),
      description: catalogString(record.description, `${label}[${index}].description`),
    };
  });
}

function parsePluginEntry(value: unknown, index: number): PluginEntry {
  const record = catalogRecord(value, `plugins[${index}]`);
  const network =
    record.network === undefined ? {} : catalogRecord(record.network, `plugins[${index}].network`);
  const tools = record.tools === undefined ? [] : record.tools;
  const commands = record.commands === undefined ? [] : record.commands;
  const secrets = record.secrets === undefined ? [] : record.secrets;

  if (!Array.isArray(tools) || !Array.isArray(commands) || !Array.isArray(secrets)) {
    throw new Error(
      `Invalid reviewed plugin catalog: plugins[${index}] capability fields must be arrays`,
    );
  }

  return {
    schemaVersion: catalogNumber(record.schemaVersion, `plugins[${index}].schemaVersion`),
    id: catalogString(record.id, `plugins[${index}].id`),
    name: catalogString(record.name, `plugins[${index}].name`),
    version: catalogString(record.version, `plugins[${index}].version`),
    hostApi: catalogNumber(record.hostApi, `plugins[${index}].hostApi`),
    artifact: catalogString(record.artifact, `plugins[${index}].artifact`),
    sha256: catalogString(record.sha256, `plugins[${index}].sha256`),
    hooks: catalogStrings(record.hooks, `plugins[${index}].hooks`),
    policyHooks: catalogStrings(record.policyHooks, `plugins[${index}].policyHooks`),
    decisionProviders: catalogStrings(
      record.decisionProviders,
      `plugins[${index}].decisionProviders`,
    ),
    tools: tools.map((item, toolIndex) => {
      const tool = catalogRecord(item, `plugins[${index}].tools[${toolIndex}]`);
      return {
        name: catalogString(tool.name, `plugins[${index}].tools[${toolIndex}].name`),
        description: catalogString(
          tool.description,
          `plugins[${index}].tools[${toolIndex}].description`,
        ),
        riskLevel: catalogString(tool.riskLevel, `plugins[${index}].tools[${toolIndex}].riskLevel`),
        egress: catalogBoolean(tool.egress, `plugins[${index}].tools[${toolIndex}].egress`),
      };
    }),
    commands: commands.map((item, commandIndex) => {
      const command = catalogRecord(item, `plugins[${index}].commands[${commandIndex}]`);
      return {
        name: catalogString(command.name, `plugins[${index}].commands[${commandIndex}].name`),
        description: catalogString(
          command.description,
          `plugins[${index}].commands[${commandIndex}].description`,
        ),
      };
    }),
    personas: catalogNamedDescriptions(record.personas, `plugins[${index}].personas`),
    skills: catalogNamedDescriptions(record.skills, `plugins[${index}].skills`),
    lifecycleHooks: catalogStrings(record.lifecycleHooks, `plugins[${index}].lifecycleHooks`),
    network: {
      destinations: catalogStrings(network.destinations, `plugins[${index}].network.destinations`),
    },
    dataSent: catalogStrings(record.dataSent, `plugins[${index}].dataSent`),
    secrets: secrets.map((item, secretIndex) => {
      const secret = catalogRecord(item, `plugins[${index}].secrets[${secretIndex}]`);
      const env =
        secret.env === undefined
          ? undefined
          : catalogString(secret.env, `plugins[${index}].secrets[${secretIndex}].env`);
      return {
        name: catalogString(secret.name, `plugins[${index}].secrets[${secretIndex}].name`),
        ...(env === undefined ? {} : { env }),
        required: catalogBoolean(
          secret.required,
          `plugins[${index}].secrets[${secretIndex}].required`,
        ),
        description: catalogString(
          secret.description,
          `plugins[${index}].secrets[${secretIndex}].description`,
        ),
      };
    }),
  };
}

let pluginEntriesPromise: Promise<PluginEntry[]> | undefined;

/** Read reviewed plugin releases from the catalog generated before Astro builds. */
export async function getPluginEntries(): Promise<PluginEntry[]> {
  pluginEntriesPromise ??= (async () => {
    for (const candidate of pluginCatalogCandidates) {
      try {
        const catalog = JSON.parse(await readFile(candidate, "utf8")) as {
          plugins?: PluginEntry[];
        };
        if (!Array.isArray(catalog.plugins)) {
          throw new Error("Invalid reviewed plugin catalog: plugins must be an array");
        }
        return catalog.plugins
          .map(parsePluginEntry)
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return [];
  })();
  return pluginEntriesPromise;
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

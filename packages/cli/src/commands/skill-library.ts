/**
 * CLI commands for the reviewed skill marketplace.
 *
 * A marketplace skill is an instruction-only `SKILL.md`. Browse and search
 * consume catalog metadata; install prints the origin, metadata, and complete
 * instructions before asking for consent, then writes exactly one file under
 * `~/.jazz/skills/<name>/`. This command never executes or imports skill text.
 */

import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  SkillRegistryServiceTag,
  type SkillRegistryService,
} from "@jazz/core/interfaces/skill-registry";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { FileSystemError, NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  RegistrySkillDownload,
  RegistrySkillEntry,
  RegistrySkillMetadata,
} from "@jazz/core/types/skill-registry";
import { getGlobalSkillsDirectory } from "@jazz/core/utils/paths";
import { toError } from "@jazz/core/utils/storage";
import chalk from "chalk";
import { Effect } from "effect";

/** The local name becomes a directory, so it must remain a plain slug. */
const VALID_SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface InstallSkillOptions {
  /** Skip the confirmation prompt. Required for non-interactive installs. */
  readonly yes?: boolean;
  /** Re-fetch the catalog instead of using the cached snapshot. */
  readonly refresh?: boolean;
}

/** Exported for command tests and other CLI callers that validate names early. */
export function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME.test(name);
}

type SkillDisplayMetadata = RegistrySkillEntry | RegistrySkillMetadata;

function formatMeta(entry: SkillDisplayMetadata): string {
  const parts = [
    entry.version ? `version: ${entry.version}` : "",
    entry.compatibility ? `compatibility: ${entry.compatibility}` : "",
    entry.license ? `license: ${entry.license}` : "",
    entry.author ? `by ${entry.author}` : "",
    entry.tags && entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : "",
  ].filter((part) => part.length > 0);
  return parts.join("  ·  ");
}

function matchesSkillQuery(entry: RegistrySkillEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return true;

  const searchable = [
    entry.name,
    entry.description,
    entry.author ?? "",
    entry.version ?? "",
    entry.compatibility ?? "",
    entry.license ?? "",
    ...(entry.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return searchable.includes(normalized);
}

/** Filter a catalog without changing its name-sorted order. */
export function filterSkillEntries(
  entries: readonly RegistrySkillEntry[],
  query?: string,
): readonly RegistrySkillEntry[] {
  return entries.filter((entry) => matchesSkillQuery(entry, query ?? ""));
}

function targetDirectory(
  name: string,
): { readonly directory: string; readonly path: string } | null {
  const root = resolve(getGlobalSkillsDirectory());
  const directory = resolve(join(root, name));
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) return null;
  return { directory, path: join(directory, "SKILL.md") };
}

function formatSkillMetadata(metadata: RegistrySkillMetadata): string {
  const meta = formatMeta(metadata);
  return meta.length > 0 ? meta : "No additional metadata";
}

/**
 * Print the exact file the user is about to install, then ask for consent.
 * Returns false when the user declines or when a non-interactive run omitted
 * `--yes`; in both cases no filesystem write occurs.
 */
function confirmInstall(
  download: RegistrySkillDownload,
  options: InstallSkillOptions,
): Effect.Effect<boolean, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    yield* terminal.heading(`Marketplace skill: ${download.entry.name}`);
    yield* terminal.log(download.metadata.description);
    yield* terminal.log(chalk.dim(`source: ${download.sourceUrl}`));
    yield* terminal.log(chalk.dim(`metadata: ${formatSkillMetadata(download.metadata)}`));
    yield* terminal.log("");
    yield* terminal.log(chalk.bold("SKILL.md"));
    yield* terminal.log(
      chalk.dim(
        "This is instruction text only. Jazz will write it as a file and will not execute or import it.",
      ),
    );
    yield* terminal.log("");

    for (const line of download.markdown.split("\n")) {
      yield* terminal.log(`  ${chalk.dim(line)}`);
    }
    yield* terminal.log("");

    if (options.yes === true) return true;

    if (!terminal.isInteractive) {
      yield* terminal.error(
        `Refusing to install "${download.entry.name}" without confirmation. Re-run with --yes to accept this skill.`,
      );
      return false;
    }

    const confirmed = yield* terminal.confirm(
      `Install skill "${download.entry.name}" under ~/.jazz/skills?`,
      false,
    );
    return confirmed === true;
  });
}

/**
 * Install one reviewed marketplace skill as a new, exact `SKILL.md` file.
 * Existing directories are never overwritten.
 */
export function installSkillCommand(
  name: string,
  options: InstallSkillOptions = {},
): Effect.Effect<
  void,
  NetworkError | ValidationError | FileSystemError,
  SkillRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* SkillRegistryServiceTag;
    const localName = name.trim();

    if (localName !== name || !isValidSkillName(localName)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "name",
          message: `"${name}" is not a valid skill name`,
          value: name,
          suggestion: "Use letters, digits, hyphens, and underscores only; paths are not allowed.",
        }),
      );
    }

    const target = targetDirectory(localName);
    if (target === null) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          message: `Skill "${localName}" resolves outside the Jazz skill directory`,
          value: localName,
          suggestion: "Choose a simple skill name rather than a path.",
        }),
      );
    }

    const existing = yield* Effect.tryPromise({
      try: () => lstat(target.directory),
      catch: toError,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (existing !== null) {
      return yield* Effect.fail(
        new FileSystemError({
          path: target.directory,
          operation: "install",
          reason: `A skill directory named "${localName}" already exists`,
          suggestion: `Remove ${target.directory} first if you intend to reinstall it.`,
        }),
      );
    }

    if (options.refresh === true) {
      yield* registry.listEntries({ refresh: true });
    }
    const download = yield* registry.fetchSkill(name);
    const accepted = yield* confirmInstall(download, options);
    if (!accepted) {
      yield* terminal.info("Install cancelled.");
      return;
    }

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(target.directory, { recursive: true });
        const directoryStat = await lstat(target.directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("skill target is not a real directory");
        }
        await writeFile(target.path, download.markdown, { encoding: "utf8", flag: "wx" });
      },
      catch: (error) =>
        new FileSystemError({
          path: target.path,
          operation: "write",
          reason: toError(error).message,
          suggestion: "Check that ~/.jazz/skills is writable and the name is not already taken.",
        }),
    });

    yield* terminal.success(`Installed skill "${localName}".`);
    yield* terminal.log(`   File: ${target.path}`);
    yield* terminal.log(
      "   The skill is instruction-only and will be discovered on the next Jazz run.",
    );
  });
}

/** List catalog metadata, optionally filtered by a case-insensitive query. */
export function listLibrarySkillsCommand(options?: {
  readonly query?: string;
  readonly refresh?: boolean;
}): Effect.Effect<void, NetworkError, SkillRegistryService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* SkillRegistryServiceTag;
    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });
    const filtered = filterSkillEntries(entries, options?.query);

    if (filtered.length === 0) {
      yield* terminal.info(
        options?.query
          ? `No marketplace skills match "${options.query}".`
          : "The skill marketplace is empty right now.",
      );
      return;
    }

    const title = options?.query
      ? `Marketplace skills matching "${options.query}" (${filtered.length})`
      : `Marketplace skills (${filtered.length})`;
    yield* terminal.heading(title);
    yield* terminal.log("");

    for (const entry of filtered) {
      yield* terminal.log(`  ${chalk.bold(entry.name)}`);
      yield* terminal.log(`    ${chalk.dim(entry.description)}`);
      const meta = formatMeta(entry);
      if (meta.length > 0) yield* terminal.log(`    ${chalk.dim(meta)}`);
      yield* terminal.log("");
    }

    yield* terminal.info("Install one: jazz skill install <name>");
  });
}

/** Interactive marketplace browser; plain terminals receive the metadata list. */
export function browseSkillLibraryCommand(options?: {
  readonly refresh?: boolean;
}): Effect.Effect<
  void,
  NetworkError | ValidationError | FileSystemError,
  SkillRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* SkillRegistryServiceTag;

    if (!terminal.isInteractive) {
      return yield* listLibrarySkillsCommand({ refresh: options?.refresh === true });
    }

    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });
    if (entries.length === 0) {
      yield* terminal.info("The skill marketplace is empty right now.");
      return;
    }

    const selected = yield* terminal.search<string>("Search marketplace skills", {
      choices: entries.map((entry) => ({
        name: entry.name,
        value: entry.name,
        description: entry.description,
      })),
      placeholder: "Type to filter by name or description",
    });

    if (selected === undefined) {
      yield* terminal.info("Nothing selected.");
      return;
    }

    yield* installSkillCommand(selected, { refresh: options?.refresh === true });
  });
}

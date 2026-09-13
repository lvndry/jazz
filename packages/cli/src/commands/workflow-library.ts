/**
 * CLI commands for the workflow library — a shared catalog of WORKFLOW.md
 * files that users can browse and copy into their own `~/.jazz/workflows/`.
 *
 * A workflow is a prompt plus the autonomy it asks for, so every install shows
 * the file in full — frontmatter included — and asks before writing it to disk.
 * Non-interactive runs must pass `--yes` to accept that explicitly. The file is
 * written byte-for-byte as published; only `--as` touches it, rewriting the
 * `name:` line so the local copy answers to its new name.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  WorkflowRegistryServiceTag,
  type WorkflowRegistryService,
} from "@jazz/core/interfaces/workflow-registry";
import { FileSystemError, NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  RegistryWorkflowDownload,
  RegistryWorkflowEntry,
} from "@jazz/core/types/workflow-registry";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { getGlobalWorkflowsDirectory } from "@jazz/core/utils/paths";
import { WorkflowServiceTag, type WorkflowService } from "@jazz/core/workflows/workflow-service";
import { renameWorkflowDefinition } from "@jazz/core/workflows/workflow-utils";
import chalk from "chalk";
import { Effect } from "effect";

/** The local name becomes a directory under ~/.jazz/workflows, so it must stay a plain slug. */
const VALID_LOCAL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface InstallWorkflowOptions {
  /** Install under a different local name (avoids clashing with an existing workflow). */
  readonly as?: string;
  /** Skip the confirmation prompt. Required for non-interactive installs. */
  readonly yes?: boolean;
  /** Re-fetch the catalog instead of using the cached snapshot. */
  readonly refresh?: boolean;
}

function describeSchedule(schedule: string): string {
  const described = describeCronSchedule(schedule);
  return described ? `${described} (${schedule})` : schedule;
}

function formatMeta(entry: RegistryWorkflowEntry): string {
  const parts = [
    entry.schedule ? `default frequency: ${describeSchedule(entry.schedule)}` : "",
    entry.autoApprove !== undefined ? `auto-approve: ${String(entry.autoApprove)}` : "",
    entry.author ? `by ${entry.author}` : "",
    entry.tags && entry.tags.length > 0 ? entry.tags.join(", ") : "",
  ].filter((part) => part.length > 0);
  return parts.join("  ·  ");
}

/**
 * Print the full file the user is about to trust, then ask.
 * Returns false when the user declines or when a non-interactive run omitted `--yes`.
 */
function confirmInstall(
  download: RegistryWorkflowDownload,
  localName: string,
  shadows: string | undefined,
  options: InstallWorkflowOptions,
): Effect.Effect<boolean, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const { autoApprove } = download.definition;

    yield* terminal.heading(`Library workflow: ${download.entry.name}`);
    yield* terminal.log(download.entry.description);
    const meta = formatMeta(download.entry);
    if (meta.length > 0) yield* terminal.log(chalk.dim(meta));
    yield* terminal.log(chalk.dim(`source: ${download.sourceUrl}`));
    yield* terminal.log("");
    yield* terminal.log(chalk.bold("WORKFLOW.md"));
    yield* terminal.log(
      chalk.dim("The frontmatter decides how it runs; the body is the prompt the agent receives."),
    );
    if (autoApprove !== undefined && autoApprove !== false) {
      yield* terminal.log(
        chalk.yellow(
          `Run with --auto-approve or on a schedule, its tools execute without asking up to the "${String(autoApprove)}" tier.`,
        ),
      );
    }
    if (shadows !== undefined) {
      yield* terminal.log(chalk.yellow(`Installing as "${localName}" shadows the ${shadows}.`));
    }
    yield* terminal.log("");

    for (const line of download.markdown.trimEnd().split("\n")) {
      yield* terminal.log(`  ${chalk.dim(line)}`);
    }
    yield* terminal.log("");

    if (options.yes === true) return true;

    if (!terminal.isInteractive) {
      yield* terminal.error(
        `Refusing to install "${localName}" without confirmation. Re-run with --yes to accept this workflow.`,
      );
      return false;
    }

    const key = yield* terminal.ask("Type i to install, anything else to go back", {
      simple: true,
      cancellable: true,
      placeholder: "i",
    });
    if (key?.trim().toLowerCase() !== "i") return false;

    return yield* terminal.confirm(`Install this workflow as "${localName}"?`, false);
  });
}

/**
 * Download one library workflow into ~/.jazz/workflows/<name>/WORKFLOW.md.
 */
export function installWorkflowCommand(
  name: string,
  options: InstallWorkflowOptions = {},
): Effect.Effect<
  void,
  NetworkError | ValidationError | FileSystemError | Error,
  WorkflowService | WorkflowRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* WorkflowRegistryServiceTag;
    const workflowService = yield* WorkflowServiceTag;

    const localName = (options.as ?? name).trim();
    if (!VALID_LOCAL_NAME.test(localName)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "name",
          message: `"${localName}" is not a valid workflow name`,
          value: localName,
          suggestion: "Use letters, digits, hyphens, and underscores only.",
        }),
      );
    }

    const targetDir = join(getGlobalWorkflowsDirectory(), localName);
    const targetPath = join(targetDir, "WORKFLOW.md");

    const existing = yield* workflowService.listWorkflows();
    const clash = existing.find((workflow) => workflow.name === localName);
    if (clash !== undefined && clash.path === targetDir) {
      return yield* Effect.fail(
        new FileSystemError({
          path: targetPath,
          operation: "install",
          reason: `You already have a workflow named "${localName}"`,
          suggestion: `Install under a different name with --as <name>, or remove ${targetDir} first.`,
        }),
      );
    }
    const shadows =
      clash === undefined
        ? undefined
        : `local workflow at ${clash.path} everywhere except this directory`;

    const download = yield* registry.fetchWorkflow(name);
    const accepted = yield* confirmInstall(download, localName, shadows, options);
    if (!accepted) {
      yield* terminal.info("Install cancelled.");
      return;
    }

    const markdown =
      localName === download.definition.name
        ? download.markdown
        : renameWorkflowDefinition(download.markdown, localName);

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, markdown, { encoding: "utf8", flag: "wx" });
      },
      catch: (error) =>
        new FileSystemError({
          path: targetPath,
          operation: "write",
          reason: error instanceof Error ? error.message : String(error),
          suggestion: "Check that ~/.jazz/workflows is writable and the name is not already taken.",
        }),
    });

    yield* workflowService.refreshCache();

    yield* terminal.success(`Installed workflow "${localName}".`);
    yield* terminal.log(`   File:      ${targetPath}`);
    yield* terminal.log(`   Run once:  jazz workflow run ${localName}`);
    if (download.definition.schedule !== undefined) {
      yield* terminal.log(
        `   Schedule:  jazz workflow schedule ${localName}  (${describeSchedule(download.definition.schedule)})`,
      );
    }
  });
}

/**
 * List everything the library offers, without installing.
 */
export function listLibraryWorkflowsCommand(options?: {
  readonly refresh?: boolean;
}): Effect.Effect<void, NetworkError, WorkflowRegistryService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* WorkflowRegistryServiceTag;

    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });

    if (entries.length === 0) {
      yield* terminal.info("The workflow library is empty right now.");
      return;
    }

    yield* terminal.heading(`Library workflows (${entries.length})`);
    yield* terminal.log("");

    for (const entry of entries) {
      yield* terminal.log(`  ${chalk.bold(entry.name)}`);
      yield* terminal.log(`    ${chalk.dim(entry.description)}`);
      const meta = formatMeta(entry);
      if (meta.length > 0) yield* terminal.log(`    ${chalk.dim(meta)}`);
      yield* terminal.log("");
    }

    yield* terminal.info("Install one: jazz workflow install <name>");
  });
}

/**
 * Interactive library browser: pick a workflow, read its file, install it.
 */
export function browseWorkflowLibraryCommand(options?: {
  readonly refresh?: boolean;
}): Effect.Effect<
  void,
  NetworkError | ValidationError | FileSystemError | Error,
  WorkflowService | WorkflowRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* WorkflowRegistryServiceTag;

    if (!terminal.isInteractive) {
      return yield* listLibraryWorkflowsCommand(options);
    }

    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });

    if (entries.length === 0) {
      yield* terminal.info("The workflow library is empty right now.");
      return;
    }

    const selected = yield* terminal.search<string>("Search library workflows", {
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

    yield* installWorkflowCommand(selected, { refresh: options?.refresh === true });
  });
}

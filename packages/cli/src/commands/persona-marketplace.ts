import { isBuiltinPersona } from "@jazz/adapters/persona-service";
import {
  PersonaRegistryServiceTag,
  type PersonaRegistryService,
} from "@jazz/core/interfaces/persona-registry";
import { PersonaServiceTag, type PersonaService } from "@jazz/core/interfaces/persona-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  NetworkError,
  PersonaAlreadyExistsError,
  StorageError,
  ValidationError,
} from "@jazz/core/types/errors";
import type {
  RegistryPersonaDownload,
  RegistryPersonaEntry,
} from "@jazz/core/types/persona-registry";
import chalk from "chalk";
import { Effect } from "effect";

/**
 * CLI commands for the persona marketplace — a shared catalog of personas that
 * users can browse and copy into their own `~/.jazz/personas/`.
 *
 * An installed persona becomes the system prompt of whichever agent uses it, so
 * every install shows the prompt in full and asks before writing it to disk.
 * Non-interactive runs must pass `--yes` to accept that explicitly.
 */

/** How much of a prompt is shown before the preview is truncated. */
const PROMPT_PREVIEW_LINES = 40;

export interface InstallPersonaOptions {
  /** Install under a different local name (avoids clashing with an existing persona). */
  readonly as?: string;
  /** Skip the confirmation prompt. Required for non-interactive installs. */
  readonly yes?: boolean;
  /** Re-fetch the catalog instead of using the cached snapshot. */
  readonly refresh?: boolean;
}

function formatMeta(entry: RegistryPersonaEntry): string {
  const parts = [
    entry.tone ? `tone: ${entry.tone}` : "",
    entry.style ? `style: ${entry.style}` : "",
    entry.author ? `by ${entry.author}` : "",
    entry.tags && entry.tags.length > 0 ? entry.tags.join(", ") : "",
  ].filter((part) => part.length > 0);
  return parts.join("  ·  ");
}

/**
 * Print the full definition the user is about to trust, then ask.
 * Returns false when the user declines or when a non-interactive run omitted `--yes`.
 */
function confirmInstall(
  download: RegistryPersonaDownload,
  localName: string,
  options: InstallPersonaOptions,
): Effect.Effect<boolean, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    yield* terminal.heading(`Marketplace persona: ${download.entry.name}`);
    yield* terminal.log(download.entry.description);
    const meta = formatMeta(download.entry);
    if (meta.length > 0) yield* terminal.log(chalk.dim(meta));
    yield* terminal.log(chalk.dim(`source: ${download.sourceUrl}`));
    yield* terminal.log("");
    yield* terminal.log(chalk.bold("System prompt"));
    yield* terminal.log(
      chalk.dim("This text becomes the instructions of any agent you apply the persona to."),
    );
    yield* terminal.log("");

    const lines = download.systemPrompt.split("\n");
    for (const line of lines.slice(0, PROMPT_PREVIEW_LINES)) {
      yield* terminal.log(`  ${chalk.dim(line)}`);
    }
    if (lines.length > PROMPT_PREVIEW_LINES) {
      yield* terminal.log(
        chalk.dim(`  … ${lines.length - PROMPT_PREVIEW_LINES} more lines at ${download.sourceUrl}`),
      );
    }
    yield* terminal.log("");

    if (options.yes === true) return true;

    if (!terminal.isInteractive) {
      yield* terminal.error(
        `Refusing to install "${localName}" without confirmation. Re-run with --yes to accept this prompt.`,
      );
      return false;
    }

    return yield* terminal.confirm(`Install this persona as "${localName}"?`, false);
  });
}

/**
 * Download one marketplace persona into ~/.jazz/personas/.
 */
export function installPersonaCommand(
  name: string,
  options: InstallPersonaOptions = {},
): Effect.Effect<
  void,
  NetworkError | StorageError | PersonaAlreadyExistsError | ValidationError,
  PersonaService | PersonaRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* PersonaRegistryServiceTag;
    const personaService = yield* PersonaServiceTag;

    const localName = (options.as ?? name).trim();

    if (isBuiltinPersona(localName)) {
      return yield* Effect.fail(
        new PersonaAlreadyExistsError({
          personaName: localName,
          suggestion: `"${localName}" is a built-in persona name. Install it under another name with --as <name>.`,
        }),
      );
    }

    const existing = yield* personaService.listPersonas();
    if (existing.some((persona) => persona.name.toLowerCase() === localName.toLowerCase())) {
      return yield* Effect.fail(
        new PersonaAlreadyExistsError({
          personaName: localName,
          suggestion: `You already have a persona named "${localName}". Install under a different name with --as <name>, or delete the existing one first.`,
        }),
      );
    }

    const download = yield* registry.fetchPersona(name);
    const accepted = yield* confirmInstall(download, localName, options);
    if (!accepted) {
      yield* terminal.info("Install cancelled.");
      return;
    }

    const persona = yield* personaService.createPersona({
      name: localName,
      description: download.description,
      systemPrompt: download.systemPrompt,
      ...(download.tone !== undefined && { tone: download.tone }),
      ...(download.style !== undefined && { style: download.style }),
    });

    yield* terminal.success(`Installed persona "${persona.name}".`);
    yield* terminal.log(`   Edit it:  jazz persona edit ${persona.name}`);
    yield* terminal.log(`   Apply it: jazz agent create  (then select "${persona.name}")`);
  });
}

/**
 * List everything the marketplace offers, without installing.
 */
export function listMarketplacePersonasCommand(options?: {
  readonly refresh?: boolean;
}): Effect.Effect<void, NetworkError, PersonaRegistryService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* PersonaRegistryServiceTag;

    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });

    if (entries.length === 0) {
      yield* terminal.info("The persona marketplace is empty right now.");
      return;
    }

    yield* terminal.heading(`Marketplace personas (${entries.length})`);
    yield* terminal.log("");

    for (const entry of entries) {
      yield* terminal.log(`  ${chalk.bold(entry.name)}`);
      yield* terminal.log(`    ${chalk.dim(entry.description)}`);
      const meta = formatMeta(entry);
      if (meta.length > 0) yield* terminal.log(`    ${chalk.dim(meta)}`);
      yield* terminal.log("");
    }

    yield* terminal.info("Install one: jazz persona install <name>");
  });
}

/**
 * Interactive marketplace browser: pick a persona, read its prompt, install it.
 */
export function browseMarketplaceCommand(options?: {
  readonly refresh?: boolean;
}): Effect.Effect<
  void,
  NetworkError | StorageError | PersonaAlreadyExistsError | ValidationError,
  PersonaService | PersonaRegistryService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const registry = yield* PersonaRegistryServiceTag;

    if (!terminal.isInteractive) {
      return yield* listMarketplacePersonasCommand(options);
    }

    const entries = yield* registry.listEntries({ refresh: options?.refresh === true });

    if (entries.length === 0) {
      yield* terminal.info("The persona marketplace is empty right now.");
      return;
    }

    const selected = yield* terminal.search<string>("Search marketplace personas", {
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

    yield* installPersonaCommand(selected, { refresh: options?.refresh === true });
  });
}

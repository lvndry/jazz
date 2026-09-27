/**
 * The in-chat command and keyboard reference for `docs/commands.md`, rendered
 * from `CHAT_COMMANDS` and the keymaps in `ui/keymaps.ts`.
 *
 * The docs page keeps its prose by hand and holds the generated tables between
 * marker comments (`<!-- chat-commands:start -->` and so on). Run
 * `bun run docs:chat-commands` to rewrite them; `reference.test.ts` fails when
 * the page and the registry disagree.
 */

import { bindingLabel, KEYMAPS, type KeymapMode } from "@/cli/ui/keymaps";
import { CHAT_COMMANDS, commandSignature, SHELL_ESCAPE_FORM } from "./constants";

/** A generated region of the docs page, between `<!-- name:start -->` and `<!-- name:end -->`. */
export interface GeneratedRegion {
  readonly name: string;
  readonly content: string;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** A markdown table with every column padded to its widest cell, as prettier formats it. */
function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cells = [header, ...rows].map((row) => row.map(escapeCell));
  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const [headerCells, ...bodyCells] = cells;
  return [
    line(headerCells ?? []),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...bodyCells.map(line),
  ].join("\n");
}

/** The in-chat command table: every built-in, its aliases, and the shell escape. */
export function renderChatCommandTable(): string {
  const rows = CHAT_COMMANDS.map((command) => {
    const aliases =
      command.aliases === undefined || command.aliases.length === 0
        ? ""
        : ` Also ${command.aliases.map((alias) => `\`/${alias}\``).join(", ")}.`;
    const link =
      command.docsLink === undefined
        ? ""
        : ` See [${command.docsLink.label}](${command.docsLink.href}).`;
    return [`\`${commandSignature(command)}\``, `${command.description}.${aliases}${link}`];
  });
  rows.push([
    `\`${SHELL_ESCAPE_FORM}\``,
    "Run a shell command and give its output to the agent. See [Shell escapes](#shell-escapes).",
  ]);
  return markdownTable(["Command", "Purpose"], rows);
}

/** The keyboard table of one interface. */
export function renderKeymapTable(mode: KeymapMode): string {
  return markdownTable(
    ["Keys", "Action"],
    KEYMAPS[mode].map((binding) => [bindingLabel(binding), binding.action]),
  );
}

/** Every region `docs/commands.md` holds, in page order. */
export function chatReferenceRegions(): readonly GeneratedRegion[] {
  return [
    { name: "chat-commands", content: renderChatCommandTable() },
    { name: "keys-fullscreen", content: renderKeymapTable("fullscreen") },
    { name: "keys-classic", content: renderKeymapTable("classic") },
  ];
}

/**
 * Replace each region's content in a markdown page. Throws when a marker pair
 * is missing, so a renamed heading cannot silently stop the page updating.
 */
export function replaceGeneratedRegions(
  markdown: string,
  regions: readonly GeneratedRegion[],
): string {
  let updated = markdown;
  for (const region of regions) {
    const start = `<!-- ${region.name}:start -->`;
    const end = `<!-- ${region.name}:end -->`;
    const startIndex = updated.indexOf(start);
    const endIndex = updated.indexOf(end);
    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error(`Missing ${start} ... ${end} markers`);
    }
    updated = `${updated.slice(0, startIndex + start.length)}\n\n${region.content}\n\n${updated.slice(endIndex)}`;
  }
  return updated;
}

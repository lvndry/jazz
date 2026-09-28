/**
 * Every `jazz ...` command Jazz tells people to run exists.
 *
 * Error messages, hints and help text suggest commands, and so do the docs. A
 * suggestion for a command that does not exist (`jazz wizard`, `jazz logs`) is
 * worse than none: the user runs it, gets "unknown command", and loses trust in
 * every other hint. This test collects the suggestions and resolves each one
 * against the real Commander tree:
 *
 * - in source, from string and template literals only (comments are prose):
 *   a `` `jazz ...` ``, `'jazz ...'` or `"jazz ..."` span inside one, or a
 *   whole plain string that starts with `jazz ` (a `relatedCommands` entry);
 * - in `docs/`, from inline code spans and shell lines in fenced blocks.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Command } from "commander";
import ts from "typescript";
import { createCLIApp } from "./cli-app";

const REPO_ROOT = path.join(import.meta.dir, "../../..");
/** The website's copy uses "jazz" as a brand name, not as a command to run. */
const NOT_CLI_SOURCE = new Set(["packages/website/src"]);
/** Every package's source, bots and plugins included: they print hints too. */
const SOURCE_ROOTS = ["packages", "plugins"].flatMap((parent) =>
  readdirSync(path.join(REPO_ROOT, parent))
    .map((name) => path.join(parent, name, "src"))
    .filter((root) => existsSync(path.join(REPO_ROOT, root)) && !NOT_CLI_SOURCE.has(root)),
);
const DOCS_ROOT = "docs";
/** Planning notes under docs/ that are not published and may name future commands. */
const UNPUBLISHED_DOCS = ["docs/superpowers"];

function filesUnder(root: string, extensions: readonly string[]): string[] {
  const absoluteRoot = path.join(REPO_ROOT, root);
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      const relative = path.relative(REPO_ROOT, full);
      if (
        entry === "node_modules" ||
        UNPUBLISHED_DOCS.some((prefix) => relative.startsWith(prefix))
      ) {
        continue;
      }
      if (statSync(full).isDirectory()) {
        visit(full);
      } else if (
        extensions.some((extension) => entry.endsWith(extension)) &&
        !/\.test\.tsx?$/.test(entry)
      ) {
        found.push(full);
      }
    }
  };
  visit(absoluteRoot);
  return found;
}

/** The command words of one suggestion: `jazz agent show <id> --json` gives `agent show`. */
export function commandWords(suggestion: string): readonly string[] {
  const words: string[] = [];
  for (const token of suggestion.trim().split(/\s+/).slice(1)) {
    if (!/^[a-z][a-z0-9-]*$/.test(token)) {
      break;
    }
    words.push(token);
  }
  return words;
}

/**
 * Whether the words name a real command path. A word that is not a subcommand
 * ends the path when the command takes arguments (it is an argument) and fails
 * it when the command only groups subcommands.
 */
export function resolvesInTree(program: Command, words: readonly string[]): boolean {
  let current = program;
  for (const [index, word] of words.entries()) {
    const next = current.commands.find(
      (candidate) => candidate.name() === word || candidate.aliases().includes(word),
    );
    if (next !== undefined) {
      current = next;
      continue;
    }
    if (index === 0) {
      return false;
    }
    return current.commands.length === 0 || current.registeredArguments.length > 0;
  }
  return true;
}

const SUGGESTION_SPAN = /[`'"](jazz [^`'"\n]+)[`'"]/g;

function suggestionsInText(text: string, wholeTextIsCommand: boolean): string[] {
  const suggestions = [...text.matchAll(SUGGESTION_SPAN)].map((match) => match[1] ?? "");
  if (wholeTextIsCommand && /^jazz [a-z]/.test(text.trim())) {
    suggestions.push(text.trim().split("\n")[0] ?? "");
  }
  return suggestions;
}

function sourceSuggestions(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const suggestions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      suggestions.push(...suggestionsInText(node.text, true));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      suggestions.push(...suggestionsInText(node.text, false));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return suggestions;
}

function docSuggestions(file: string): string[] {
  const suggestions: string[] = [];
  let inFence = false;
  let fenceIsShell = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      inFence = !inFence;
      fenceIsShell =
        inFence && ["", "bash", "sh", "shell", "console", "zsh"].includes(fence[1] ?? "");
      continue;
    }
    if (inFence) {
      const command = line.trim().replace(/^\$\s*/, "");
      if (fenceIsShell && /^jazz [a-z]/.test(command)) {
        suggestions.push(command);
      }
      continue;
    }
    suggestions.push(...suggestionsInText(line, false));
  }
  return suggestions;
}

describe("suggested jazz commands", () => {
  const program = createCLIApp();

  function unresolved(collect: (file: string) => string[], files: readonly string[]): string[] {
    return files.flatMap((file) =>
      collect(file)
        .filter((suggestion) => !resolvesInTree(program, commandWords(suggestion)))
        .map((suggestion) => `${path.relative(REPO_ROOT, file)}: ${suggestion}`),
    );
  }

  it("resolves every command suggested in source strings", () => {
    const files = SOURCE_ROOTS.flatMap((root) => filesUnder(root, [".ts", ".tsx"]));
    expect(unresolved(sourceSuggestions, files)).toEqual([]);
  });

  it("resolves every command shown in the docs", () => {
    const files = [...filesUnder(DOCS_ROOT, [".md"]), path.join(REPO_ROOT, "README.md")];
    expect(unresolved(docSuggestions, files)).toEqual([]);
  });

  it("tells a real command from a missing one", () => {
    expect(resolvesInTree(program, commandWords("jazz agent show <id>"))).toBe(true);
    expect(resolvesInTree(program, commandWords("jazz run --agent x"))).toBe(true);
    expect(resolvesInTree(program, commandWords("jazz agent get <id>"))).toBe(false);
    expect(resolvesInTree(program, commandWords("jazz wizard"))).toBe(false);
  });
});

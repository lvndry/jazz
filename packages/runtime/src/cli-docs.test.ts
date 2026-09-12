/**
 * Keeps the command lookup page aligned with the live Commander tree and runtime defaults.
 *
 * The documentation is intentionally organized by user task rather than mirroring code, so this
 * test checks factual coverage without constraining its prose or section layout.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_MAX_ITERATIONS } from "@jazz/core/constants/agent";
import { describe, expect, it } from "bun:test";
import { createCLIApp } from "./cli-app";

const DOCS_PATH = "docs/commands.md";

describe(DOCS_PATH, () => {
  const markdown = readFileSync(DOCS_PATH, "utf-8");
  const app = createCLIApp();

  function publicCommands(): readonly import("commander").Command[] {
    const commands: import("commander").Command[] = [];
    function visit(parent: import("commander").Command): void {
      for (const command of parent.commands) {
        if (!command.description().startsWith("Internal:")) commands.push(command);
        visit(command);
      }
    }
    visit(app);
    return commands;
  }

  function commandPath(command: import("commander").Command): string {
    const names: string[] = [];
    let current: import("commander").Command | null = command;
    while (current?.parent) {
      names.unshift(current.name());
      current = current.parent;
    }
    return names.join(" ");
  }

  it("mentions every public top-level command", () => {
    const missing = app.commands
      .filter((command) => !command.description().startsWith("Internal:"))
      .map((command) => command.name())
      .filter((name) => !markdown.includes(`jazz ${name}`));

    expect(missing, `${DOCS_PATH} is missing commands: ${missing.join(", ")}`).toEqual([]);
  });

  it("mentions every public command path", () => {
    const missing = publicCommands()
      .map(commandPath)
      .filter((path) => !markdown.includes(`jazz ${path}`));

    expect(missing, `${DOCS_PATH} is missing command paths: ${missing.join(", ")}`).toEqual([]);
  });

  it("mentions every public long option", () => {
    const missing = [
      ...new Set(
        publicCommands().flatMap((command) => command.options.map((option) => option.long)),
      ),
    ].filter((flag) => flag !== undefined && !markdown.includes(flag));

    expect(missing, `${DOCS_PATH} is missing flags: ${missing.join(", ")}`).toEqual([]);
  });

  it("records the runtime's default iteration limit", () => {
    const row = markdown.split("\n").find((line) => line.includes("`--max-iterations <n>`"));
    expect(row).toContain(`| ${DEFAULT_MAX_ITERATIONS}`);
  });
});

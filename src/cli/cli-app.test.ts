import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { createCLIApp } from "./cli-app";

const CLI_APP_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "cli-app.ts"),
  "utf8",
);

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /^import(?:\s+type)?\s+[\s\S]*?from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("createCLIApp help path", () => {
  it("does not statically import the agent stack", () => {
    const specifiers = staticImportSpecifiers(CLI_APP_SOURCE);
    expect(specifiers).not.toContain("../app-layer");
    expect(specifiers).not.toContain("./commands/run/execute");
    expect(specifiers).not.toContain("./commands/media-agents");
    expect(specifiers).not.toContain("./commands/agent-management");
    expect(specifiers).not.toContain("./commands/chat-agent");
    expect(specifiers).not.toContain("./commands/wizard");
    expect(specifiers).not.toContain("./commands/workflow");
    expect(specifiers).not.toContain("./commands/config");
    expect(specifiers).not.toContain("./commands/mcp");
    expect(specifiers).not.toContain("./commands/persona");
    expect(specifiers).not.toContain("./commands/update");
    expect(specifiers).not.toContain("./commands/create-agent");
    expect(specifiers).not.toContain("./commands/edit-agent");
    expect(specifiers).not.toContain("./commands/run/lifecycle");
  });

  it("registers the public command families", () => {
    const program = createCLIApp();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "agent",
        "run",
        "config",
        "mcp",
        "persona",
        "update",
        "runs",
        "workflow",
      ]),
    );
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { createCLIApp, firstOperand } from "./cli-app";

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
    expect(specifiers).not.toContain("./app-layer");
    expect(specifiers).not.toContain("@jazz/cli/commands/run/execute");
    expect(specifiers).not.toContain("@jazz/cli/commands/media-agents");
    expect(specifiers).not.toContain("@jazz/cli/commands/agent-management");
    expect(specifiers).not.toContain("@jazz/cli/commands/chat-agent");
    expect(specifiers).not.toContain("@jazz/cli/commands/wizard");
    expect(specifiers).not.toContain("@jazz/cli/commands/workflow");
    expect(specifiers).not.toContain("@jazz/cli/commands/config");
    expect(specifiers).not.toContain("@jazz/cli/commands/mcp");
    expect(specifiers).not.toContain("@jazz/cli/commands/persona");
    expect(specifiers).not.toContain("@jazz/cli/commands/update");
    expect(specifiers).not.toContain("@jazz/cli/commands/create-agent");
    expect(specifiers).not.toContain("@jazz/cli/commands/edit-agent");
    expect(specifiers).not.toContain("@jazz/cli/commands/run/lifecycle");
  });

  it("offers --stream on `workflow run`, as headless reasoning events depend on it", () => {
    const program = createCLIApp();
    const workflow = program.commands.find((command) => command.name() === "workflow");
    const run = workflow?.commands.find((command) => command.name() === "run");
    const flags = run?.options.map((option) => option.flags) ?? [];
    expect(flags).toContain("--stream");
    expect(flags).toContain("--no-stream");
    expect(flags).toContain("--events <categories>");
  });

  it("registers one daemon status command alongside pause, resume and logs", () => {
    const daemon = createCLIApp().commands.find((command) => command.name() === "daemon");
    const names = daemon?.commands.map((command) => command.name()) ?? [];
    expect(names.filter((name) => name === "status")).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["pause", "resume", "logs"]));
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

  it("keeps config validation available as a recovery command", () => {
    const program = createCLIApp();
    const config = program.commands.find((command) => command.name() === "config");
    expect(config?.commands.map((command) => command.name())).toContain("validate");
  });
});

describe("firstOperand", () => {
  const program = createCLIApp(["bun", "jazz", "agent", "list"]);

  it("finds no operand when only global flags are given, so the home opens", () => {
    expect(firstOperand(program, [])).toBeUndefined();
    expect(firstOperand(program, ["--no-tui"])).toBeUndefined();
    expect(firstOperand(program, ["--debug", "--verbose"])).toBeUndefined();
    expect(firstOperand(program, ["--data-dir", "/tmp/work"])).toBeUndefined();
    expect(firstOperand(program, ["--data-dir=/tmp/work", "--output", "raw"])).toBeUndefined();
  });

  it("returns the subcommand after global flags and their values", () => {
    expect(firstOperand(program, ["agent", "list"])).toBe("agent");
    expect(firstOperand(program, ["--data-dir", "/tmp/work", "agent", "list"])).toBe("agent");
    expect(firstOperand(program, ["--config", "agent", "run"])).toBe("run");
  });

  it("returns a mistyped command so Commander can reject it", () => {
    expect(firstOperand(program, ["--debug", "agnt"])).toBe("agnt");
  });
});

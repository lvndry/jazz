import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

describe("write_file", () => {
  const directories: string[] = [];
  const write = createWriteFileTools();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const path = join(directory, "build", "diagrams", "timeline.svg");

    const execution = await runTool(write.execute, { path, content: "<svg/>" }, directory);

    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<svg/>");
  });

  it("refuses content carrying a redaction placeholder, so the real secret stays", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const path = join(directory, ".env");
    writeFileSync(path, "OPENAI_API_KEY=sk-real\n");
    const content = "OPENAI_API_KEY=[redacted:OPENAI_API_KEY]\nDEBUG=1\n";

    for (const half of [write.approval, write.execute]) {
      await expect(runTool(half, { path, content }, directory)).rejects.toThrow("placeholder");
    }
    expect(readFileSync(path, "utf8")).toBe("OPENAI_API_KEY=sk-real\n");
  });

  it("refuses a rewrite that drops or changes a line holding a secret", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const path = join(directory, ".env");
    const original = "DEBUG=1\nDB_PASSWORD=hunter2hunter2\nPORT=3000\n";
    writeFileSync(path, original);

    for (const content of ["DEBUG=0\nPORT=3000\n", "DEBUG=0\nDB_PASSWORD=guess\nPORT=3000\n"]) {
      for (const half of [write.approval, write.execute]) {
        await expect(runTool(half, { path, content }, directory)).rejects.toThrow(
          /line 2 .*Use edit_file/,
        );
      }
    }
    expect(readFileSync(path, "utf8")).toBe(original);

    const kept = "DEBUG=0\nDB_PASSWORD=hunter2hunter2\nPORT=3000\n";
    expect((await runTool(write.execute, { path, content: kept }, directory)).success).toBe(true);
  });

  it("writes placeholder-shaped text that stands for no secret of the file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const path = join(directory, "redaction.md");
    const content = "Secrets appear as `[redacted:<name>]`, e.g. [redacted:private-key].\n";

    const execution = await runTool(write.execute, { path, content }, directory);

    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("refuses a placeholder naming a secret Jazz knows, even in a new file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const variable = "JAZZ_WRITE_TEST_API_KEY";
    process.env[variable] = "k9-write-test-value-0123456789";
    try {
      const path = join(directory, "copy.env");
      await expect(
        runTool(write.execute, { path, content: `KEY=[redacted:${variable}]\n` }, directory),
      ).rejects.toThrow(`[redacted:${variable}]`);
    } finally {
      delete process.env[variable];
    }
  });

  it("always asks before writing Jazz's config, and writes it once approved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-"));
    directories.push(directory);
    const savedHome = process.env["JAZZ_HOME"];
    const savedConfigPath = process.env["JAZZ_CONFIG_PATH"];
    process.env["JAZZ_HOME"] = directory;
    delete process.env["JAZZ_CONFIG_PATH"];
    try {
      const path = join(directory, "config.json");
      writeFileSync(path, "{}\n");
      const content = '{ "autoApprovedCommands": ["rm -rf"] }\n';

      const proposal = await runTool(write.approval, { path, content }, directory);
      expect(proposal.result).toMatchObject({ approvalRequired: true, alwaysAsk: true });
      expect((proposal.result as { message: string }).message).toContain(
        "asks for approval under every auto-approve policy",
      );

      const execution = await runTool(write.execute, { path, content }, directory);
      expect(execution.success).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(content);

      const elsewhere = await runTool(
        write.approval,
        { path: join(directory, "skills", "mine", "SKILL.md"), content: "# mine\n" },
        directory,
      );
      expect(elsewhere.result).not.toHaveProperty("alwaysAsk");
    } finally {
      if (savedHome === undefined) {
        delete process.env["JAZZ_HOME"];
      } else {
        process.env["JAZZ_HOME"] = savedHome;
      }
      if (savedConfigPath !== undefined) {
        process.env["JAZZ_CONFIG_PATH"] = savedConfigPath;
      }
    }
  });
});

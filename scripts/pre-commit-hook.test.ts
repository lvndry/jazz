/**
 * Runs `.githooks/pre-commit` through real `git commit` calls in throwaway repositories, with a
 * fake `pre-commit` that rewrites one file and fails its first run the way a formatter does.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const hooksDirectory = path.resolve(import.meta.dir, "../.githooks");
const gitDirectory = path.dirname(Bun.which("git") ?? "/usr/bin/git");
const basePath = `${gitDirectory}:/usr/bin:/bin`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly repository: string;
  readonly fakeBin: string;
}

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function createFixture(trackedFiles: Readonly<Record<string, string>>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "jazz-pre-commit-hook-"));
  directories.push(root);
  const repository = path.join(root, "repository");
  const fakeBin = path.join(root, "bin");
  mkdirSync(repository);
  mkdirSync(fakeBin);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "hook@test.invalid"]);
  git(repository, ["config", "user.name", "hook test"]);
  for (const [name, content] of Object.entries(trackedFiles)) {
    writeFileSync(path.join(repository, name), content);
  }
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-q", "-m", "initial"]);
  git(repository, ["config", "core.hooksPath", hooksDirectory]);
  return { repository, fakeBin };
}

/**
 * A `pre-commit` that, like a formatter, checks the staged copy of `formattedFile`: it passes once
 * the staged copy ends in the formatted line, and otherwise fails, appending that line to the
 * worktree copy on its first run.
 */
function installFormattingPreCommit(fixture: Fixture, formattedFile: string): void {
  const firstRunMarker = path.join(fixture.fakeBin, "ran");
  const script = path.join(fixture.fakeBin, "pre-commit");
  writeFileSync(
    script,
    `#!/bin/sh
if git show ":${formattedFile}" | tail -n 1 | grep -qx formatted; then
  exit 0
fi
if [ ! -e "${firstRunMarker}" ]; then
  : > "${firstRunMarker}"
  printf 'formatted\\n' >> "${path.join(fixture.repository, formattedFile)}"
fi
exit 1
`,
  );
  chmodSync(script, 0o755);
}

function commit(fixture: Fixture, environment: Readonly<Record<string, string>>) {
  return spawnSync("git", ["commit", "-q", "-m", "change"], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: { HOME: fixture.repository, ...environment },
  });
}

function committedContent(fixture: Fixture, file: string): string {
  return git(fixture.repository, ["show", `HEAD:${file}`]);
}

describe(".githooks/pre-commit", () => {
  test("blocks a CI commit too when pre-commit is missing", () => {
    const fixture = createFixture({ "notes.md": "one\n" });
    writeFileSync(path.join(fixture.repository, "notes.md"), "two\n");
    git(fixture.repository, ["add", "notes.md"]);

    const result = commit(fixture, { PATH: basePath, CI: "true" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uv tool install --force pre-commit");
  });

  test("blocks a local commit with the install command when pre-commit is missing", () => {
    const fixture = createFixture({ "notes.md": "one\n" });
    writeFileSync(path.join(fixture.repository, "notes.md"), "two\n");
    git(fixture.repository, ["add", "notes.md"]);

    const result = commit(fixture, { PATH: basePath });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uv tool install --force pre-commit");
  });

  test("commits a formatter's fix to a staged file without staging other edited files", () => {
    const fixture = createFixture({ "staged.md": "one\n", "unstaged.md": "one\n" });
    writeFileSync(path.join(fixture.repository, "staged.md"), "two\n");
    writeFileSync(path.join(fixture.repository, "unstaged.md"), "left out\n");
    git(fixture.repository, ["add", "staged.md"]);
    installFormattingPreCommit(fixture, "staged.md");

    const result = commit(fixture, { PATH: `${fixture.fakeBin}:${basePath}` });

    expect(result.status).toBe(0);
    expect(committedContent(fixture, "staged.md")).toBe("two\nformatted\n");
    expect(committedContent(fixture, "unstaged.md")).toBe("one\n");
  });

  test("keeps a filename containing a newline as one path when re-staging", () => {
    const newlineName = "first\nsecond.md";
    const fixture = createFixture({ [newlineName]: "one\n", first: "one\n", "second.md": "one\n" });
    writeFileSync(path.join(fixture.repository, newlineName), "two\n");
    writeFileSync(path.join(fixture.repository, "first"), "left out\n");
    writeFileSync(path.join(fixture.repository, "second.md"), "left out\n");
    git(fixture.repository, ["add", "--", newlineName]);
    installFormattingPreCommit(fixture, newlineName);

    const result = commit(fixture, { PATH: `${fixture.fakeBin}:${basePath}` });

    expect(result.status).toBe(0);
    expect(committedContent(fixture, newlineName)).toBe("two\nformatted\n");
    expect(committedContent(fixture, "first")).toBe("one\n");
    expect(committedContent(fixture, "second.md")).toBe("one\n");
  });

  test("refuses to re-stage a partially staged file so its unstaged edits stay out", () => {
    const fixture = createFixture({ "notes.md": "one\n" });
    writeFileSync(path.join(fixture.repository, "notes.md"), "two\n");
    git(fixture.repository, ["add", "notes.md"]);
    writeFileSync(path.join(fixture.repository, "notes.md"), "two\nunstaged\n");
    installFormattingPreCommit(fixture, "notes.md");

    const result = commit(fixture, { PATH: `${fixture.fakeBin}:${basePath}` });

    expect(result.status).not.toBe(0);
    expect(committedContent(fixture, "notes.md")).toBe("one\n");
    expect(readFileSync(path.join(fixture.repository, "notes.md"), "utf8")).toBe(
      "two\nunstaged\nformatted\n",
    );
  });
});

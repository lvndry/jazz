/** Regressions for global skill removal, consent, and filesystem boundaries. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { removeSkillCommand } from "./skill-remove";

let jazzHome: string;
let originalJazzHome: string | undefined;

function terminal(interactive = false, confirm = () => Effect.succeed(false)) {
  const service = {
    isInteractive: interactive,
    confirm: mock(confirm),
    info: mock(() => Effect.void),
    error: mock(() => Effect.void),
    success: mock(() => Effect.void),
  };
  const layer = Layer.succeed(TerminalServiceTag, service as unknown as TerminalService);
  return { service, layer };
}

function createSkill(name = "journal"): string {
  const directory = join(jazzHome, "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "# Keep a journal\n");
  return directory;
}

beforeEach(() => {
  originalJazzHome = process.env["JAZZ_HOME"];
  jazzHome = mkdtempSync(join(tmpdir(), "jazz-skill-remove-test-"));
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(() => {
  if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = originalJazzHome;
  rmSync(jazzHome, { recursive: true, force: true });
});

describe("removeSkillCommand", () => {
  it("removes the chosen skill and assets without following linked assets or touching siblings", async () => {
    const directory = createSkill();
    const sibling = createSkill("other");
    const outside = join(jazzHome, "outside.txt");
    writeFileSync(outside, "keep");
    writeFileSync(join(directory, "asset.txt"), "asset");
    symlinkSync(outside, join(directory, "linked-asset"));
    await Effect.runPromise(
      removeSkillCommand("journal", { yes: true }).pipe(Effect.provide(terminal().layer)),
    );
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(join(sibling, "SKILL.md"))).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("requires --yes without a terminal and respects an interactive refusal", async () => {
    const directory = createSkill();
    const plain = terminal();
    await Effect.runPromise(removeSkillCommand("journal").pipe(Effect.provide(plain.layer)));
    expect(plain.service.error).toHaveBeenCalled();
    const interactive = terminal(true);
    await Effect.runPromise(removeSkillCommand("journal").pipe(Effect.provide(interactive.layer)));
    expect(interactive.service.confirm).toHaveBeenCalled();
    expect(existsSync(join(directory, "SKILL.md"))).toBe(true);
  });

  it("removes after interactive confirmation", async () => {
    const directory = createSkill();
    await Effect.runPromise(
      removeSkillCommand("journal").pipe(
        Effect.provide(terminal(true, () => Effect.succeed(true)).layer),
      ),
    );
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects path-shaped names and reports a missing skill", async () => {
    const directory = createSkill();
    for (const name of ["../journal", "/tmp/journal", "journal/", " journal", "missing"]) {
      const exit = await Effect.runPromiseExit(
        removeSkillCommand(name, { yes: true }).pipe(Effect.provide(terminal().layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
    expect(existsSync(directory)).toBe(true);
  });

  it("refuses a linked skill directory and a linked global root", async () => {
    const directory = createSkill();
    symlinkSync(directory, join(jazzHome, "skills", "linked"));
    const linkedExit = await Effect.runPromiseExit(
      removeSkillCommand("linked", { yes: true }).pipe(Effect.provide(terminal().layer)),
    );
    expect(Exit.isFailure(linkedExit)).toBe(true);
    renameSync(join(jazzHome, "skills"), join(jazzHome, "saved-skills"));
    symlinkSync(join(jazzHome, "saved-skills"), join(jazzHome, "skills"));
    const rootExit = await Effect.runPromiseExit(
      removeSkillCommand("journal", { yes: true }).pipe(Effect.provide(terminal().layer)),
    );
    expect(Exit.isFailure(rootExit)).toBe(true);
    expect(existsSync(join(jazzHome, "saved-skills", "journal", "SKILL.md"))).toBe(true);
  });

  it("refuses directories without a regular skill definition", async () => {
    const directory = createSkill();
    rmSync(join(directory, "SKILL.md"));
    writeFileSync(join(directory, "keep.txt"), "keep");
    const exit = await Effect.runPromiseExit(
      removeSkillCommand("journal", { yes: true }).pipe(Effect.provide(terminal().layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(join(directory, "keep.txt"))).toBe(true);
  });

  it("refuses a directory replaced while awaiting confirmation", async () => {
    const directory = createSkill();
    const interactive = terminal(true, () =>
      Effect.sync(() => {
        renameSync(directory, join(jazzHome, "original-journal"));
        createSkill();
        return true;
      }),
    );
    const exit = await Effect.runPromiseExit(
      removeSkillCommand("journal").pipe(Effect.provide(interactive.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(join(directory, "SKILL.md"))).toBe(true);
    expect(existsSync(join(jazzHome, "original-journal", "SKILL.md"))).toBe(true);
  });
});

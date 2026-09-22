import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillRegistryServiceTag,
  type SkillRegistryService,
} from "@jazz/core/interfaces/skill-registry";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { RegistrySkillDownload } from "@jazz/core/types/skill-registry";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { filterSkillEntries, installSkillCommand, isValidSkillName } from "./skill-library";

/** Command-level regressions for confirmation, path safety, and exact writes. */

const MARKDOWN = `---
name: release-council
description: Run a multi-agent release review
---

# Release council

Review the release.
`;

const download: RegistrySkillDownload = {
  entry: {
    name: "release-council",
    description: "Run a multi-agent release review",
    author: "Jazz",
    tags: ["release"],
    url: "https://registry.test/library/skills/release-council/SKILL.md",
  },
  sourceUrl: "https://registry.test/library/skills/release-council/SKILL.md",
  markdown: MARKDOWN,
  metadata: {
    name: "release-council",
    description: "Run a multi-agent release review",
  },
};

let jazzHome: string;
let originalJazzHome: string | undefined;

function terminal(interactive: boolean): TerminalService {
  return {
    isInteractive: interactive,
    heading: mock(() => Effect.void),
    info: mock(() => Effect.void),
    log: mock(() => Effect.succeed(undefined)),
    success: mock(() => Effect.void),
    error: mock(() => Effect.void),
    warn: mock(() => Effect.void),
    user: mock(() => Effect.void),
    debug: mock(() => Effect.void),
    clear: mock(() => Effect.void),
    ask: mock(() => Effect.succeed(undefined)),
    password: mock(() => Effect.succeed("")),
    select: mock(() => Effect.succeed(undefined)),
    confirm: mock(() => Effect.succeed(false)),
    search: mock(() => Effect.succeed(undefined)),
    checkbox: mock(() => Effect.succeed([])),
    setTitle: mock(() => Effect.void),
  } as unknown as TerminalService;
}

function registry(): SkillRegistryService {
  return {
    listEntries: mock(() => Effect.succeed([download.entry])),
    fetchSkill: mock(() => Effect.succeed(download)),
  };
}

beforeEach(() => {
  originalJazzHome = process.env["JAZZ_HOME"];
  jazzHome = mkdtempSync(join(tmpdir(), "jazz-skill-command-test-"));
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(() => {
  if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = originalJazzHome;
  rmSync(jazzHome, { recursive: true, force: true });
});

describe("skill marketplace commands", () => {
  it("validates names and filters catalog metadata", () => {
    expect(isValidSkillName("release-council")).toBe(true);
    expect(isValidSkillName("../outside")).toBe(false);
    expect(filterSkillEntries([download.entry], "release")).toHaveLength(1);
    expect(filterSkillEntries([download.entry], "calendar")).toHaveLength(0);
  });

  it("writes the exact SKILL.md only after --yes", async () => {
    const service = registry();
    const layer = Layer.mergeAll(
      Layer.succeed(SkillRegistryServiceTag, service),
      Layer.succeed(TerminalServiceTag, terminal(false)),
    );

    const exit = await Effect.runPromiseExit(
      installSkillCommand("release-council", { yes: true }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(readFileSync(join(jazzHome, "skills", "release-council", "SKILL.md"), "utf8")).toBe(
      MARKDOWN,
    );
  });

  it("refuses non-interactive installation without --yes", async () => {
    const service = registry();
    const plainTerminal = terminal(false);
    const layer = Layer.mergeAll(
      Layer.succeed(SkillRegistryServiceTag, service),
      Layer.succeed(TerminalServiceTag, plainTerminal),
    );

    await Effect.runPromise(installSkillCommand("release-council").pipe(Effect.provide(layer)));

    expect(plainTerminal.error as ReturnType<typeof mock>).toHaveBeenCalled();
    expect(() => readFileSync(join(jazzHome, "skills", "release-council", "SKILL.md"))).toThrow();
  });

  it("rejects path-shaped names before consulting the registry", async () => {
    const service = registry();
    const layer = Layer.mergeAll(
      Layer.succeed(SkillRegistryServiceTag, service),
      Layer.succeed(TerminalServiceTag, terminal(false)),
    );

    const exit = await Effect.runPromiseExit(
      installSkillCommand("../outside", { yes: true }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(service.fetchSkill as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });
});

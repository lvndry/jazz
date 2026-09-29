import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileSystem } from "@effect/platform/FileSystem";
import { type Agent } from "@jazz/core/types/index";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Option } from "effect";
import { FileStorageService } from "./file";

// Mock FileSystem
const mockFS = {
  makeDirectory: mock(() => Effect.void),
  readFileString: mock(() => Effect.succeed("{}")),
  writeFileString: mock(() => Effect.void),
  readDirectory: mock(() => Effect.succeed([])),
  remove: mock(() => Effect.void),
  access: mock(() => Effect.void),
  copy: mock(() => Effect.void),
  copyFile: mock(() => Effect.void),
  chmod: mock(() => Effect.void),
  chown: mock(() => Effect.void),
  exists: mock(() => Effect.succeed(true)),
  link: mock(() => Effect.void),
  lstat: mock(() => Effect.succeed({})),
  mkdir: mock(() => Effect.void),
  makeTempDirectory: mock(() => Effect.succeed("")),
  makeTempDirectoryScoped: mock(() => Effect.succeed("")),
  makeTempFile: mock(() => Effect.succeed("")),
  makeTempFileScoped: mock(() => Effect.succeed("")),
  open: mock(() => Effect.succeed({})),
  readSymbolicLink: mock(() => Effect.succeed("")),
  realpath: mock(() => Effect.succeed("")),
  rename: mock(() => Effect.void),
  removeFile: mock(() => Effect.void),
  stat: mock(() => Effect.succeed({ birthtime: Option.none(), mtime: Option.none() })),
  symlink: mock(() => Effect.void),
  truncate: mock(() => Effect.void),
  utimes: mock(() => Effect.void),
  writeFile: mock(() => Effect.void),
} as unknown as FileSystem;

const AGENT: Agent = {
  id: "a1",
  name: "Agent 1",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4" } },
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("FileStorageService", () => {
  const service = new FileStorageService("/tmp/jazz", mockFS);

  it("saves an agent durably to a private JSON file", async () => {
    const root = mkdtempSync(join(tmpdir(), "jazz-agents-"));
    const realService = new FileStorageService(root, mockFS);
    await Effect.runPromise(realService.saveAgent(AGENT));

    const target = join(root, "agents", "a1.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({ id: "a1", name: "Agent 1" });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "agents"))).toEqual(["a1.json"]);
  });

  it("fails and leaves no temporary file when the agents directory cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "jazz-agents-"));
    writeFileSync(join(root, "agents"), "");
    const realService = new FileStorageService(root, mockFS);
    const result = await Effect.runPromiseExit(realService.saveAgent(AGENT));
    expect(result._tag).toBe("Failure");
    expect(readdirSync(root)).toEqual(["agents"]);
  });

  it("should list agents from directory", async () => {
    // @ts-expect-error - mocking
    mockFS.readDirectory.mockReturnValueOnce(Effect.succeed(["a1.json"]));
    // @ts-expect-error - mocking
    mockFS.readFileString.mockReturnValueOnce(
      Effect.succeed(
        JSON.stringify({
          id: "a1",
          name: "Agent 1",
          config: { persona: "default", llm: { provider: "openai", model: "gpt-4" } },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    );

    const program = service.listAgents();
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("a1");
  });

  it("reports an agent file with the flat model fields as unreadable", async () => {
    // @ts-expect-error - mocking
    mockFS.readDirectory.mockReturnValueOnce(Effect.succeed(["old.json"]));
    // @ts-expect-error - mocking
    mockFS.readFileString.mockReturnValueOnce(
      Effect.succeed(
        JSON.stringify({
          id: "old",
          name: "Old",
          config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
        }),
      ),
    );

    const inspection = await Effect.runPromise(service.inspectAgentFiles());

    expect(inspection.agents).toEqual([]);
    expect(inspection.unreadable).toHaveLength(1);
    expect(inspection.unreadable[0]?.reason).toContain("Missing config.llm");
  });

  it("should list agents when createdAt and updatedAt are omitted from JSON", async () => {
    // @ts-expect-error - mocking
    mockFS.readDirectory.mockReturnValueOnce(Effect.succeed(["a1.json"]));
    // @ts-expect-error - mocking
    mockFS.readFileString.mockReturnValueOnce(
      Effect.succeed(
        JSON.stringify({
          id: "a1",
          name: "Agent 1",
          config: { persona: "default", llm: { provider: "openai", model: "gpt-4" } },
        }),
      ),
    );

    const born = new Date("2026-01-02T03:04:05.000Z");
    const modified = new Date("2026-02-03T04:05:06.000Z");
    // @ts-expect-error - mocking
    mockFS.stat.mockReturnValueOnce(
      Effect.succeed({ birthtime: Option.some(born), mtime: Option.some(modified) }),
    );

    const program = service.listAgents();
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.createdAt).toEqual(born);
    expect(result[0]!.updatedAt).toEqual(modified);
  });

  it("should handle missing file as StorageNotFoundError", async () => {
    // @ts-expect-error - mocking
    mockFS.readFileString.mockReturnValueOnce(Effect.fail({ _tag: "NotFound" }));

    const program = service.getAgent("missing");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      // @ts-expect-error - accessing error
      expect(result.cause.error._tag).toBe("StorageNotFoundError");
    }
  });
});

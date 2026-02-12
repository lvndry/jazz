import { type FileSystem } from "@effect/platform/FileSystem";
import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { FileStorageService } from "./file";
import { type Agent } from "../../core/types/index";

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
  stat: mock(() => Effect.succeed({})),
  symlink: mock(() => Effect.void),
  truncate: mock(() => Effect.void),
  utimes: mock(() => Effect.void),
  writeFile: mock(() => Effect.void),
} as unknown as FileSystem;

describe("FileStorageService", () => {
  const service = new FileStorageService("/tmp/jazz", mockFS);

  it("should save an agent to a JSON file", async () => {
    const agent: Agent = {
      id: "a1",
      name: "Agent 1",
      config: { agentType: "default", llmProvider: "openai", llmModel: "gpt-4" },
      createdAt: new Date(),
      updatedAt: new Date(),
      model: "openai/gpt-4",
    };

    const program = service.saveAgent(agent);
    await Effect.runPromise(program);

    expect(mockFS.makeDirectory).toHaveBeenCalledWith("/tmp/jazz/agents", { recursive: true });
    expect(mockFS.writeFileString).toHaveBeenCalledWith(
      "/tmp/jazz/agents/a1.json",
      expect.stringContaining('"name": "Agent 1"'),
    );
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
          config: { agentType: "default", llmProvider: "openai", llmModel: "gpt-4" },
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

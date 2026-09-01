import { type FileSystem } from "@effect/platform/FileSystem";
import { type Agent } from "@jazz/core/types/index";
import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
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
  stat: mock(() => Effect.succeed({})),
  symlink: mock(() => Effect.void),
  truncate: mock(() => Effect.void),
  utimes: mock(() => Effect.void),
  writeFile: mock(() => Effect.void),
} as unknown as FileSystem;

const AGENT: Agent = {
  id: "a1",
  name: "Agent 1",
  config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TEMP_PATH_PATTERN = /^\/tmp\/jazz\/agents\/\.agent-\d+-[a-z0-9]+\.tmp$/;

describe("FileStorageService", () => {
  const service = new FileStorageService("/tmp/jazz", mockFS);

  it("should save an agent to a JSON file", async () => {
    const agent: Agent = {
      id: "a1",
      name: "Agent 1",
      config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const program = service.saveAgent(agent);
    await Effect.runPromise(program);

    expect(mockFS.makeDirectory).toHaveBeenCalledWith("/tmp/jazz/agents", { recursive: true });
    expect(mockFS.writeFileString).toHaveBeenCalledWith(
      expect.stringMatching(TEMP_PATH_PATTERN),
      expect.stringContaining('"name": "Agent 1"'),
    );
    expect(mockFS.rename).toHaveBeenCalledWith(
      expect.stringMatching(TEMP_PATH_PATTERN),
      "/tmp/jazz/agents/a1.json",
    );
  });

  describe("atomic write failure paths", () => {
    function agentServiceWithMock(overrides: Partial<typeof mockFS>) {
      const fs = {
        ...mockFS,
        makeDirectory: mock(() => Effect.void),
        writeFileString: mock(() => Effect.void),
        rename: mock(() => Effect.void),
        remove: mock(() => Effect.void),
        ...overrides,
      } as unknown as FileSystem;
      return { fs, service: new FileStorageService("/tmp/jazz", fs) };
    }

    it("leaves the target file untouched when the temp write fails", async () => {
      const { fs, service: svc } = agentServiceWithMock({
        writeFileString: mock(() => Effect.fail(new Error("disk full"))),
      });

      const result = await Effect.runPromiseExit(svc.saveAgent(AGENT));

      expect(result._tag).toBe("Failure");
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("cleans up the temporary file when rename fails", async () => {
      const { fs, service: svc } = agentServiceWithMock({
        rename: mock(() => Effect.fail(new Error("cross-device link"))),
      });

      const result = await Effect.runPromiseExit(svc.saveAgent(AGENT));

      expect(result._tag).toBe("Failure");
      expect(fs.remove).toHaveBeenCalledWith(expect.stringMatching(TEMP_PATH_PATTERN));
    });

    it("produces a complete, readable file on a successful write", async () => {
      let writtenTempPath: string | undefined;
      let writtenContent: string | undefined;
      const { service: svc } = agentServiceWithMock({
        writeFileString: mock((path: string, content: string) => {
          writtenTempPath = path;
          writtenContent = content;
          return Effect.void;
        }),
        rename: mock((from: string, to: string) => {
          expect(from).toBe(writtenTempPath);
          expect(to).toBe("/tmp/jazz/agents/a1.json");
          return Effect.void;
        }),
      });

      await Effect.runPromise(svc.saveAgent(AGENT));

      expect(writtenContent).toBeDefined();
      expect(JSON.parse(writtenContent ?? "")).toMatchObject({ id: "a1", name: "Agent 1" });
    });
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
          config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
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

  it("should list agents when createdAt and updatedAt are omitted from JSON", async () => {
    // @ts-expect-error - mocking
    mockFS.readDirectory.mockReturnValueOnce(Effect.succeed(["a1.json"]));
    // @ts-expect-error - mocking
    mockFS.readFileString.mockReturnValueOnce(
      Effect.succeed(
        JSON.stringify({
          id: "a1",
          name: "Agent 1",
          config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4" },
        }),
      ),
    );

    const program = service.listAgents();
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.createdAt).toBeInstanceOf(Date);
    expect(result[0]!.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(result[0]!.createdAt.getTime())).toBe(false);
    expect(Number.isNaN(result[0]!.updatedAt.getTime())).toBe(false);
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

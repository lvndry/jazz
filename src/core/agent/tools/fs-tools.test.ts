import { NodeFileSystem } from "@effect/platform-node";
import { beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import { createHeadTool, createTailTool } from "./fs-tools";

describe("fs tools - head/tail", () => {
  const tmpDir = "/tmp/jazz-tests";
  const filePath = `${tmpDir}/testfile.txt`;
  const content = [
    "line1",
    "line2",
    "line3",
    "line4",
    "line5",
    "line6",
    "line7",
    "line8",
    "line9",
    "line10",
  ].join("\n");

  beforeAll(async () => {
    const fs = await import("fs/promises");
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  });

  it("head returns first N lines (default 10)", async () => {
    const tool = createHeadTool();
    const layer = Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(FileSystemContextServiceTag, {
        getCwd: () => Effect.succeed(tmpDir),
        setCwd: () => Effect.void,
        resolvePath: (_key, path: string) =>
          Effect.succeed(path.startsWith("/") ? path : `${tmpDir}/${path}`),
        findDirectory: () => Effect.succeed({ results: [] }),
        resolvePathForMkdir: (_key, path: string) =>
          Effect.succeed(path.startsWith("/") ? path : `${tmpDir}/${path}`),
        escapePath: (v: string) => v,
      }),
    );

    const res = await Effect.runPromise(
      tool.execute({ path: filePath, lines: 3 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const result = res.result as { content: string; returnedLines: number };
    expect(result.returnedLines).toBe(3);
    expect(result.content.split(/\r?\n/).length).toBe(3);
    expect(result.content.startsWith("line1")).toBe(true);
  });

  it("tail returns last N lines (default 10)", async () => {
    const tool = createTailTool();
    const layer = Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(FileSystemContextServiceTag, {
        getCwd: () => Effect.succeed(tmpDir),
        setCwd: () => Effect.void,
        resolvePath: (_k, p: string) => Effect.succeed(p.startsWith("/") ? p : `${tmpDir}/${p}`),
        findDirectory: () => Effect.succeed({ results: [] }),
        resolvePathForMkdir: (_k, p: string) =>
          Effect.succeed(p.startsWith("/") ? p : `${tmpDir}/${p}`),
        escapePath: (v: string) => v,
      }),
    );

    const res = await Effect.runPromise(
      tool.execute({ path: filePath, lines: 2 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const result = res.result as { content: string; returnedLines: number };
    expect(result.returnedLines).toBe(2);
    expect(result.content.split(/\r?\n/)[0]).toBe("line9");
  });
});

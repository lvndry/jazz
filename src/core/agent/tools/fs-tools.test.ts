import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
  createCdTool,
  createFindPathTool,
  createHeadTool,
  createLsTool,
  createPwdTool,
  createReadFileTool,
  createStatTool,
  createTailTool,
} from "./fs";
import { FileSystemContextServiceTag } from "../../interfaces/fs";
import type { ToolExecutionResult } from "../../types/tools";

// Tests create a unique temp base directory and clean up after running

const BASE = `/tmp/jazz-tests-${Date.now()}`;
const HEADTAIL_DIR = `${BASE}/headtail`;
const EXTRA_DIR = `${BASE}/extra`;

function makeLayer(baseDir: string) {
  // Provide a simple FileSystemContextService mock that maps to the baseDir
  let cwd = baseDir;
  return Layer.mergeAll(
    NodeFileSystem.layer,
    Layer.succeed(FileSystemContextServiceTag, {
      getCwd: () => Effect.succeed(cwd),
      setCwd: (_k, p: string) =>
        Effect.sync(() => {
          cwd = p;
        }),
      resolvePath: (_key, path: string) =>
        Effect.succeed(path.startsWith("/") ? path : `${cwd}/${path}`),
      findDirectory: (_key, name: string, _maxDepth = 3) =>
        // Delegate to trivial scan using fs via NodeFileSystem later when needed; tests that need find use the service's implementation directly
        Effect.succeed({ results: [] }),
      resolvePathForMkdir: (_key, path: string) =>
        Effect.succeed(path.startsWith("/") ? path : `${cwd}/${path}`),
      escapePath: (v: string) => v,
    }),
  );
}

// Setup / teardown
beforeAll(async () => {
  const fs = await import("fs/promises");
  // Create base subdirs
  await fs.mkdir(HEADTAIL_DIR, { recursive: true });
  await fs.mkdir(EXTRA_DIR + "/sub/inner", { recursive: true });

  // head/tail sample file
  const htFile = `${HEADTAIL_DIR}/testfile.txt`;
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
  await fs.writeFile(htFile, lines, "utf8");

  // extra files: BOM, nested
  const sample = `${EXTRA_DIR}/sample.txt`;
  const bom = "\uFEFF";
  const sampleLines = ["first line", "second line", "third line", "fourth line"].join("\n");
  await fs.writeFile(sample, bom + sampleLines, "utf8");
  const inner = `${EXTRA_DIR}/sub/inner/inner.txt`;
  await fs.writeFile(inner, "inner1\ninner2\n", "utf8");
});

afterAll(async () => {
  const fs = await import("fs/promises");
  // Best-effort cleanup
  await fs.rm(BASE, { recursive: true, force: true }).catch(() => undefined);
});

// Category: Head & Tail behavior
describe("fs tools — head & tail", () => {
  it("head returns first N lines and handles small files", async () => {
    const filePath = `${HEADTAIL_DIR}/testfile.txt`;
    const tool = createHeadTool();
    const layer = makeLayer(HEADTAIL_DIR);

    // Request fewer lines than file
    const res: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ path: filePath, lines: 3 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.returnedLines).toBe(3);
    expect(r.content.split(/\r?\n/)[0]).toBe("line1");

    // Request more lines than file -> should return available lines
    const res2: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ path: filePath, lines: 100 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res2.success).toBe(true);
    const r2 = res2.result as any;
    expect(r2.returnedLines).toBe(10);
  });

  it("tail returns last N lines and supports small files", async () => {
    const filePath = `${HEADTAIL_DIR}/testfile.txt`;
    const tool = createTailTool();
    const layer = makeLayer(HEADTAIL_DIR);

    const res: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ path: filePath, lines: 2 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.returnedLines).toBe(2);
    expect(r.content.split(/\r?\n/)[0]).toBe("line9");
  });
});

// Category: Read file (BOM, ranges, maxBytes)
describe("fs tools — read_file", () => {
  it("reads full file, strips BOM, and returns line counts", async () => {
    const filePath = `${EXTRA_DIR}/sample.txt`;
    const tool = createReadFileTool();
    const layer = makeLayer(EXTRA_DIR);

    const res: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ path: filePath }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.totalLines).toBe(4);
    expect(r.returnedLines).toBe(4);
    expect(r.content.startsWith("first line")).toBe(true);
  });

  it("supports startLine/endLine ranges and respects bounds", async () => {
    const filePath = `${EXTRA_DIR}/sample.txt`;
    const tool = createReadFileTool();
    const layer = makeLayer(EXTRA_DIR);

    const res: ToolExecutionResult = await Effect.runPromise(
      tool
        .execute({ path: filePath, startLine: 2, endLine: 3 }, { agentId: "t" })
        .pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.returnedLines).toBe(2);
    expect(r.content.split(/\r?\n/)[0]).toBe("second line");
  });

  it("honors maxBytes and reports truncation", async () => {
    const fs = await import("fs/promises");
    const p = `${EXTRA_DIR}/big.txt`;
    // Make a long file
    const long = "a".repeat(200_000);
    await fs.writeFile(p, long, "utf8");

    const tool = createReadFileTool();
    const layer = makeLayer(EXTRA_DIR);

    const res: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ path: p, maxBytes: 50_000 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(50_000);
  });
});

// Category: Listing & searching
describe("fs tools — ls & find_path", () => {
  it("ls can list non-recursively and recursively", async () => {
    const tool = createLsTool();
    const layer = makeLayer(EXTRA_DIR);

    const nonrec: ToolExecutionResult = await Effect.runPromise(
      tool
        .execute({ path: EXTRA_DIR, recursive: false }, { agentId: "t" })
        .pipe(Effect.provide(layer)),
    );
    expect(nonrec.success).toBe(true);
    const arr = nonrec.result as any[];
    expect(arr.length).toBeGreaterThan(0);

    const rec: ToolExecutionResult = await Effect.runPromise(
      tool
        .execute({ path: EXTRA_DIR, recursive: true }, { agentId: "t" })
        .pipe(Effect.provide(layer)),
    );
    expect(rec.success).toBe(true);
    const arr2 = rec.result as any[];
    // recursive should find nested file
    expect(arr2.some((e) => e.name === "inner.txt")).toBe(true);
  });

  it("find_path finds items by partial name within depth", async () => {
    const tool = createFindPathTool();
    const layer = makeLayer(EXTRA_DIR);

    const res: ToolExecutionResult = await Effect.runPromise(
      tool.execute({ name: "inner", maxDepth: 4 }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(res.success).toBe(true);
    const r = res.result as any;
    expect(r.results.some((it: any) => it.name.includes("inner"))).toBe(true);
  });
});

// Category: Stat & existence
describe("fs tools — stat", () => {
  it("returns metadata for files and directories and handles missing path", async () => {
    const tool = createStatTool();
    const layer = makeLayer(EXTRA_DIR);

    const resFile: ToolExecutionResult = await Effect.runPromise(
      tool
        .execute({ path: `${EXTRA_DIR}/sample.txt` }, { agentId: "t" })
        .pipe(Effect.provide(layer)),
    );
    expect(resFile.success).toBe(true);
    const rf = resFile.result as any;
    expect(rf.exists).toBe(true);
    expect(rf.type).toBeDefined();

    const resMissing: ToolExecutionResult | { success: false; error: string } = await Effect.runPromise(
      tool
        .execute({ path: `${EXTRA_DIR}/nope` }, { agentId: "t" })
        .pipe(Effect.provide(layer))
        .pipe(
          Effect.match({
            onFailure: (e) => ({ success: false, error: String(e) }) as const,
            onSuccess: (result) => result,
          }),
        ),
    );
    // stat returns exists:false for missing path (or an error wrapper) — ensure we get a consistent result object
    if (resMissing && resMissing.success === true) {
      const rm = resMissing as any;
      expect(rm.result.exists).toBe(false);
    } else {
      // If stat failed, ensure it's a clear error about the file not being found
      const errorMsg = String((resMissing as any).error);
      expect(
        errorMsg.includes("ENOENT") ||
          errorMsg.includes("NotFound") ||
          errorMsg.includes("no such file") ||
          errorMsg.includes("Path not found"),
      ).toBe(true);
    }
  });
});

// Category: Navigation (pwd/cd)
describe("fs tools — navigation (pwd/cd)", () => {
  it("pwd returns cwd and cd sets it via the context service", async () => {
    const cdTool = createCdTool();
    const pwdTool = createPwdTool();
    // We'll use a layer backed by base EXTRA_DIR so setCwd will update internal cwd
    let internalCwd = EXTRA_DIR;
    const layer = Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(FileSystemContextServiceTag, {
        getCwd: () => Effect.succeed(internalCwd),
        setCwd: (_k, p: string) => Effect.sync(() => (internalCwd = p)),
        resolvePath: (_k, p: string) =>
          Effect.succeed(p.startsWith("/") ? p : `${internalCwd}/${p}`),
        findDirectory: (_k, _name: string, _maxDepth = 3) => Effect.succeed({ results: [] }),
        resolvePathForMkdir: (_k, p: string) =>
          Effect.succeed(p.startsWith("/") ? p : `${internalCwd}/${p}`),
        escapePath: (v: string) => v,
      }),
    );

    const before: ToolExecutionResult = await Effect.runPromise(
      pwdTool.execute({}, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(before.success).toBe(true);

    const cdRes: ToolExecutionResult = await Effect.runPromise(
      cdTool.execute({ path: EXTRA_DIR }, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(cdRes.success).toBe(true);

    const after: ToolExecutionResult = await Effect.runPromise(
      pwdTool.execute({}, { agentId: "t" }).pipe(Effect.provide(layer)),
    );
    expect(after.success).toBe(true);
  });
});

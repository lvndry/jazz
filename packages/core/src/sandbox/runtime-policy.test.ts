import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types/tools";
import { denyWriteOutsideRoots, fsWriteDeniedMessage } from "./runtime-policy";

let workspace: string;
let outside: string;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jazz-fs-guard-")));
  outside = mkdtempSync(path.join(process.cwd(), ".fs-guard-outside-"));
  mkdirSync(path.join(workspace, "src"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const fileSystemContext: FileSystemContextService = {
  getCwd: () => Effect.succeed(workspace),
  setCwd: () => Effect.void,
  resolvePath: (_key, target) => Effect.succeed(path.resolve(workspace, target)),
  findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
  resolvePathForMkdir: (_key, target) => Effect.succeed(path.resolve(workspace, target)),
  escapePath: (target) => target,
};

function guard(context: Partial<ToolExecutionContext>, targets: readonly string[]) {
  return Effect.runPromise(
    denyWriteOutsideRoots({ agentId: "agent", ...context }, targets).pipe(
      Effect.provide(Layer.succeed(FileSystemContextServiceTag, fileSystemContext)),
    ),
  );
}

describe("denyWriteOutsideRoots", () => {
  it("does nothing when confinement is off or unset", async () => {
    expect(await guard({ shellConfinement: "off" }, [path.join(outside, "x")])).toBeUndefined();
    expect(await guard({}, [path.join(outside, "x")])).toBeUndefined();
  });

  it("allows targets inside the working directory", async () => {
    expect(
      await guard({ shellConfinement: "on" }, [path.join(workspace, "src", "a.ts")]),
    ).toBeUndefined();
  });

  it("refuses a target outside the roots with a result naming the path", async () => {
    const target = path.join(outside, "x");
    const denied = await guard({ shellConfinement: "on" }, [path.join(workspace, "ok"), target]);
    expect(denied?.success).toBe(false);
    expect(denied?.error).toBe(fsWriteDeniedMessage(target, workspace));
  });

  it("refuses a .. escape out of the working directory", async () => {
    const escape = path.relative(workspace, path.join(outside, "x"));
    const denied = await guard({ shellConfinement: "on" }, [escape]);
    expect(denied?.success).toBe(false);
  });
});

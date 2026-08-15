import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  abbreviateHomePath,
  requireValidAgentId,
  resolveStorageDirectory,
  writeFileStringAtomic,
} from "./storage";

describe("abbreviateHomePath", () => {
  test("replaces the home-directory prefix with a tilde", () => {
    expect(
      abbreviateHomePath(
        path.join(os.homedir(), ".jazz", "memory", "agent-1", "people", "user.md"),
      ),
    ).toBe(path.join("~", ".jazz", "memory", "agent-1", "people", "user.md"));
  });

  test("does not abbreviate paths outside the home directory", () => {
    expect(abbreviateHomePath("/tmp/jazz/memory/agent-1")).toBe("/tmp/jazz/memory/agent-1");
  });
});

describe("resolveStorageDirectory", () => {
  test("trims a configured file storage path", () => {
    expect(resolveStorageDirectory({ type: "file", path: "  /tmp/jazz-data  " })).toBe(
      "/tmp/jazz-data",
    );
  });
});

describe("requireValidAgentId", () => {
  class TestAgentIdError extends Error {}

  test("accepts storage-safe IDs and rejects path-like IDs", async () => {
    await expect(
      Effect.runPromise(requireValidAgentId("agent-1_test", TestAgentIdError)),
    ).resolves.toBeUndefined();
    const invalid = await Effect.runPromise(
      requireValidAgentId("../agent", TestAgentIdError).pipe(Effect.either),
    );
    expect(invalid._tag).toBe("Left");
    if (invalid._tag === "Left") {
      expect(invalid.left).toBeInstanceOf(TestAgentIdError);
    }
  });
});

describe("writeFileStringAtomic", () => {
  test("creates parent directories and replaces the complete file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-storage-"));
    const target = path.join(root, "nested", "state.txt");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const platformFileSystem = yield* FileSystem.FileSystem;
          yield* writeFileStringAtomic(platformFileSystem, target, "first", {
            tempPrefix: "test",
          });
          yield* writeFileStringAtomic(platformFileSystem, target, "second", {
            tempPrefix: "test",
          });
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      expect(fs.readFileSync(target, "utf8")).toBe("second");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

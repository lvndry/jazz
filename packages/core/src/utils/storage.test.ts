/**
 * Regression coverage for durable writes, cancellation, cross-process locks and quarantine.
 * Run with `bun test packages/core/src/utils/storage.test.ts`.
 */
import * as fs from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
  abbreviateHomePath,
  quarantineCorruptFile,
  requireValidAgentId,
  resolveStorageDirectory,
  withLock,
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
  test("holds the lock until a cancelled durable write settles", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-cancel-write-"));
    const target = path.join(root, "state.txt");
    const lock = path.join(root, "state.lock");
    const syncing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalOpen = nodeFs.open;
    let paused = false;
    const open = spyOn(nodeFs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (!paused && args[1] === "wx" && String(args[0]).startsWith(root)) {
        paused = true;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          syncing.resolve();
          await resume.promise;
          await sync();
        };
      }
      return handle;
    });
    const first = Effect.runFork(withLock(lock, writeFileStringAtomic(target, "old")));
    try {
      await syncing.promise;
      const interrupted = Effect.runPromise(Fiber.interrupt(first));
      await Bun.sleep(20);
      expect(fs.existsSync(lock)).toBe(true);
      const second = Effect.runPromise(withLock(lock, writeFileStringAtomic(target, "new")));
      resume.resolve();
      await interrupted;
      await second;
      expect(fs.readFileSync(target, "utf8")).toBe("new");
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      resume.resolve();
      await Effect.runPromise(Fiber.await(first));
      open.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates parent directories and replaces the complete file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-storage-"));
    const target = path.join(root, "nested", "state.txt");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* writeFileStringAtomic(target, "first");
          yield* writeFileStringAtomic(target, "second");
        }),
      );
      expect(fs.readFileSync(target, "utf8")).toBe("second");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(target))).toEqual(["state.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("withLock", () => {
  test("creates a missing parent directory before taking the lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lock-"));
    const lockPath = path.join(root, "memory", "personal.lock");

    try {
      const result = await Effect.runPromise(
        withLock(
          lockPath,
          Effect.sync(() => fs.existsSync(lockPath)),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      expect(result).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails immediately when the lock directory cannot be created", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lock-"));
    const blockingFile = path.join(root, "not-a-directory");
    fs.writeFileSync(blockingFile, "");
    const lockPath = path.join(blockingFile, "personal.lock");

    try {
      const startedAt = Date.now();
      const error = await Effect.runPromise(
        withLock(lockPath, Effect.void).pipe(Effect.flip, Effect.provide(NodeFileSystem.layer)),
      );
      expect(error.message).not.toContain("Timed out");
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("still treats an existing lock as contention", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lock-"));
    const lockPath = path.join(root, "held.lock");
    fs.mkdirSync(lockPath);

    try {
      const error = await Effect.runPromise(
        withLock(lockPath, Effect.void, { maxWaitMs: 200 }).pipe(Effect.flip),
      );
      expect(error.message).toContain("Timed out");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("withLock ownership", () => {
  test("a holder's release leaves alone a lock that another holder now owns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lock-"));
    const lockPath = path.join(root, "state.lock");
    try {
      await Effect.runPromise(
        withLock(
          lockPath,
          Effect.sync(() => {
            fs.rmSync(lockPath, { recursive: true });
            fs.mkdirSync(lockPath);
            fs.writeFileSync(
              path.join(lockPath, "owner.json"),
              JSON.stringify({ pid: process.pid, host: os.hostname(), token: "someone-else" }),
            );
          }),
        ),
      );
      expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent holders in one process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lock-"));
    const lockPath = path.join(root, "state.lock");
    let inside = 0;
    let mostInside = 0;
    try {
      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 5 }, () =>
            withLock(
              lockPath,
              Effect.gen(function* () {
                inside += 1;
                mostInside = Math.max(mostInside, inside);
                yield* Effect.sleep(10);
                inside -= 1;
              }),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      );
      expect(mostInside).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("quarantineCorruptFile", () => {
  test("moves the file aside with its bytes intact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-quarantine-"));
    const target = path.join(root, "state.json");
    fs.writeFileSync(target, "{torn");
    try {
      const moved = await Effect.runPromise(quarantineCorruptFile(target, "test"));
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readFileSync(moved, "utf8")).toBe("{torn");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

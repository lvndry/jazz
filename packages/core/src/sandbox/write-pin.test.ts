import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { pinWriteTargets } from "./pinned-writes";
import { pinTargets, recheckPins } from "./write-pin";

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(process.cwd(), ".write-pin-test-")));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const policy = () => ({ roots: [workspace] });

/** Replaces `directory` with a symlink to `outside`, as a racing command would. */
function swapForSymlink(directory: string): void {
  renameSync(directory, `${directory}.moved`);
  symlinkSync(outside, directory);
}

describe("pinTargets and recheckPins", () => {
  test("a target inside the roots pins to its real path and rechecks clean", () => {
    mkdirSync(path.join(workspace, "pkg"));
    const pinned = pinTargets(policy(), ["pkg/file.txt"], workspace, true);
    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      expect(pinned.pins[0]?.realPath).toBe(path.join(workspace, "pkg", "file.txt"));
      expect(recheckPins(policy(), pinned.pins)).toBeUndefined();
    }
  });

  test("a target outside the roots is denied at pin time", () => {
    const pinned = pinTargets(policy(), [path.join(outside, "x")], workspace, true);
    expect(pinned).toEqual({ ok: false, deniedPath: path.join(outside, "x") });
  });

  test("swapping the parent directory for a symlink between check and mutation is refused", () => {
    const parent = path.join(workspace, "swap-parent");
    mkdirSync(parent);
    const pinned = pinTargets(policy(), ["swap-parent/file.txt"], workspace, true);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    swapForSymlink(parent);
    expect(recheckPins(policy(), pinned.pins)).toBeDefined();
  });

  test("swapping an ancestor of a not-yet-created path is refused", () => {
    const ancestor = path.join(workspace, "swap-ancestor");
    mkdirSync(ancestor);
    const pinned = pinTargets(policy(), ["swap-ancestor/new/deep/file.txt"], workspace, true);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    swapForSymlink(ancestor);
    expect(recheckPins(policy(), pinned.pins)).toBeDefined();
  });

  test("replacing the parent with a different real directory is refused by identity", () => {
    const parent = path.join(workspace, "swap-identity");
    mkdirSync(parent);
    const pinned = pinTargets(policy(), ["swap-identity/file.txt"], workspace, true);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    renameSync(parent, `${parent}.moved`);
    mkdirSync(parent);
    expect(recheckPins(policy(), pinned.pins)).toBeDefined();
  });

  test("an unchanged parent with new children still passes", () => {
    const parent = path.join(workspace, "stable");
    mkdirSync(parent);
    const pinned = pinTargets(policy(), ["stable/a/b.txt"], workspace, true);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    mkdirSync(path.join(parent, "a"));
    expect(recheckPins(policy(), pinned.pins)).toBeUndefined();
  });

  test("without follow the final component stays the entry itself", () => {
    symlinkSync(path.join(outside, "target.txt"), path.join(workspace, "entry-link"));
    const entry = pinTargets(policy(), ["entry-link"], workspace, false);
    const followed = pinTargets(policy(), ["entry-link"], workspace, true);
    expect(entry.ok && entry.pins[0]?.realPath).toBe(path.join(workspace, "entry-link"));
    expect(followed.ok).toBe(false);
  });
});

describe("pinWriteTargets", () => {
  const fileSystemContext: FileSystemContextService = {
    getCwd: () => Effect.succeed(workspace),
    setCwd: () => Effect.void,
    resolvePath: (_key, target) => Effect.succeed(path.resolve(workspace, target)),
    findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
    resolvePathForMkdir: (_key, target) => Effect.succeed(path.resolve(workspace, target)),
    escapePath: (target) => target,
  };
  const layer = Layer.succeed(FileSystemContextServiceTag, fileSystemContext);

  test("passes targets through untouched when confinement is off", async () => {
    const pin = await Effect.runPromise(
      pinWriteTargets({ agentId: "a", shellConfinement: "off" }, ["/anywhere/x"]).pipe(
        Effect.provide(layer),
      ),
    );
    expect(pin.denied).toBeUndefined();
    expect(pin.paths).toEqual(["/anywhere/x"]);
    expect(await Effect.runPromise(pin.recheck())).toBeUndefined();
  });

  test("returns a refusal from recheck after the parent is swapped for a symlink", async () => {
    const parent = path.join(workspace, "effect-parent");
    mkdirSync(parent);
    const pin = await Effect.runPromise(
      pinWriteTargets({ agentId: "a", shellConfinement: "on" }, [path.join(parent, "f.txt")], {
        follow: true,
      }).pipe(Effect.provide(layer)),
    );
    expect(pin.denied).toBeUndefined();
    expect(await Effect.runPromise(pin.recheck())).toBeUndefined();

    swapForSymlink(parent);
    const refused = await Effect.runPromise(pin.recheck());
    expect(refused?.success).toBe(false);
    expect(refused?.error).toContain("changed while the write was being prepared");
  });
});

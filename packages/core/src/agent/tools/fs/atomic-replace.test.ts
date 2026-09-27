import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { replacePathAtomically, writeFileAtomically } from "./atomic-replace";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-atomic-"));
  scratch.push(directory);
  return directory;
}

function withFs<A>(use: (fs: FileSystem.FileSystem) => Effect.Effect<A, Error>) {
  return Effect.flatMap(FileSystem.FileSystem, use).pipe(Effect.provide(NodeFileSystem.layer));
}

const OLD_CONTENT = "old ".repeat(1_000);
const NEW_CONTENT = "new ".repeat(2_000_000);

/** Writer kills per run, each a little later, so some land while the write is in progress. */
const KILL_ATTEMPTS = 8;
/** Spacing of those kills: a write of KILLED_WRITE_BYTES takes a few tens of milliseconds. */
const KILL_DELAY_STEP_MS = 4;

/** Big enough that a write is still in progress when the writer is killed. */
const KILLED_WRITE_BYTES = 100_000_000;

describe("writeFileAtomically", () => {
  it("leaves the old or the new content, never a partial file, whenever it is interrupted", async () => {
    const directory = scratchDirectory();
    const target = join(directory, "notes.txt");
    for (let attempt = 0; attempt < 20; attempt++) {
      writeFileSync(target, OLD_CONTENT);
      const fiber = Effect.runFork(withFs((fs) => writeFileAtomically(fs, target, NEW_CONTENT)));
      await Bun.sleep(attempt);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const content = readFileSync(target, "utf8");
      expect(content === OLD_CONTENT || content === NEW_CONTENT).toBe(true);
    }
    expect(readdirSync(directory)).toEqual(["notes.txt"]);
  });

  it("leaves the old or the new content when the writing process is SIGKILLed", async () => {
    const directory = scratchDirectory();
    const target = join(directory, "big.txt");
    const moduleUrl = new URL("./atomic-replace.ts", import.meta.url).href;
    const script = `
      import { FileSystem } from "@effect/platform";
      import { NodeFileSystem } from "@effect/platform-node";
      import { Effect } from "effect";
      import { writeFileAtomically } from ${JSON.stringify(moduleUrl)};
      const content = "n".repeat(${KILLED_WRITE_BYTES});
      process.stdout.write("writing\\n");
      await Effect.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => writeFileAtomically(fs, ${JSON.stringify(target)}, content))
          .pipe(Effect.provide(NodeFileSystem.layer)),
      );
    `;
    for (let attempt = 0; attempt < KILL_ATTEMPTS; attempt++) {
      writeFileSync(target, "old");
      const writer = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, stdout: "pipe" });
      const reader = writer.stdout.getReader();
      await reader.read();
      await Bun.sleep(attempt * KILL_DELAY_STEP_MS);
      writer.kill("SIGKILL");
      await writer.exited;

      const size = statSync(target).size;
      expect(size === 3 || size === KILLED_WRITE_BYTES).toBe(true);
    }
  }, 30_000);

  it("keeps the file's permissions", async () => {
    const target = join(scratchDirectory(), "run.sh");
    writeFileSync(target, "echo old\n");
    chmodSync(target, 0o750);

    await Effect.runPromise(withFs((fs) => writeFileAtomically(fs, target, "echo new\n")));

    expect(readFileSync(target, "utf8")).toBe("echo new\n");
    expect(statSync(target).mode & 0o777).toBe(0o750);
  });
});

describe("replacePathAtomically", () => {
  it("leaves the destination untouched when staging is interrupted", async () => {
    const directory = scratchDirectory();
    const destination = join(directory, "target");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "kept");

    const fiber = Effect.runFork(
      withFs((fs) =>
        replacePathAtomically(fs, destination, (stagingPath) =>
          fs.makeDirectory(stagingPath).pipe(
            Effect.zipRight(fs.writeFileString(join(stagingPath, "half.txt"), "half")),
            Effect.zipRight(Effect.never),
            Effect.mapError((error) => new Error(String(error))),
          ),
        ),
      ),
    );
    await Bun.sleep(50);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(readdirSync(destination)).toEqual(["keep.txt"]);
    expect(readdirSync(directory)).toEqual(["target"]);
  });

  it("replaces an existing directory whole rather than merging into it", async () => {
    const directory = scratchDirectory();
    const destination = join(directory, "target");
    mkdirSync(destination);
    writeFileSync(join(destination, "stale.txt"), "stale");

    await Effect.runPromise(
      withFs((fs) =>
        replacePathAtomically(fs, destination, (stagingPath) =>
          fs.makeDirectory(stagingPath).pipe(
            Effect.zipRight(fs.writeFileString(join(stagingPath, "fresh.txt"), "fresh")),
            Effect.mapError((error) => new Error(String(error))),
          ),
        ),
      ),
    );

    expect(readdirSync(destination)).toEqual(["fresh.txt"]);
    expect(readdirSync(directory)).toEqual(["target"]);
  });
});

/** Regression coverage for durable credential-copy provenance and protected registry mutation. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertNotProtectionStateMutation,
  getProtectedFileRoots,
  getProtectedFilesRegistryPath,
  registerProtectedFileRoots,
} from "./protected-files";

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-protected-files-")));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = path.join(root, "home");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("protected file provenance", () => {
  test("persists concurrent registrations privately and reloads after process restart", async () => {
    expect(getProtectedFileRoots()).toEqual([]);
    const paths = [path.join(root, "one"), path.join(root, "two")];
    await Promise.all(paths.map((entry) => registerProtectedFileRoots([entry])));
    expect([...getProtectedFileRoots()].sort()).toEqual(paths);
    expect(fs.statSync(getProtectedFilesRegistryPath()).mode & 0o777).toBe(0o600);
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { getProtectedFileRoots } from ${JSON.stringify(import.meta.dir + "/protected-files.ts")}; console.log(JSON.stringify(getProtectedFileRoots()));`,
      ],
      env: { ...process.env, JAZZ_HOME: path.join(root, "home") },
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString()).sort()).toEqual(paths);
  });

  test("records a missing destination through a symlinked ancestor", async () => {
    fs.mkdirSync(path.join(root, "actual"));
    fs.symlinkSync(path.join(root, "actual"), path.join(root, "alias"));
    const lexical = path.join(root, "alias", "missing", "secret");
    await registerProtectedFileRoots([lexical]);
    expect(getProtectedFileRoots()).toContain(lexical);
    expect(getProtectedFileRoots()).toContain(path.join(root, "actual", "missing", "secret"));
  });

  test("corrupt, structurally invalid, and unreadable state fail closed without exposing contents", async () => {
    fs.mkdirSync(path.dirname(getProtectedFilesRegistryPath()), { recursive: true });
    for (const contents of ["TOP_SECRET", '{"version":1,"roots":["relative"]}', "null"]) {
      fs.writeFileSync(getProtectedFilesRegistryPath(), contents);
      expect(getProtectedFileRoots).toThrow("Protected-file state is unavailable");
      await expect(registerProtectedFileRoots([path.join(root, "new")])).rejects.toThrow(
        "Protected-file state is unavailable",
      );
      expect(fs.readFileSync(getProtectedFilesRegistryPath(), "utf8")).toBe(contents);
    }
    fs.unlinkSync(getProtectedFilesRegistryPath());
    fs.mkdirSync(getProtectedFilesRegistryPath());
    expect(getProtectedFileRoots).toThrow("Protected-file state is unavailable");
  });

  test("dangling destination symlinks cannot silently lose canonical provenance", async () => {
    const destination = path.join(root, "link");
    fs.symlinkSync(path.join(root, "missing"), destination);
    await expect(registerProtectedFileRoots([destination])).rejects.toThrow(
      "Protected-file state is unavailable",
    );
  });

  test("denies state, lock descendants, temp siblings, and ancestor mutation through aliases", () => {
    fs.mkdirSync(path.dirname(getProtectedFilesRegistryPath()), { recursive: true });
    fs.symlinkSync(path.dirname(getProtectedFilesRegistryPath()), path.join(root, "alias"));
    const registry = getProtectedFilesRegistryPath();
    for (const target of [
      registry,
      `${registry}.lock`,
      `${registry}.lock/owner.json`,
      `${registry}.lock.guard/owner.json`,
      path.join(path.dirname(registry), `.${path.basename(registry)}-1-id.tmp`),
      `${registry}.corrupt-stamp`,
      root,
      path.dirname(registry),
      path.join(root, "alias", ".protected-files.json"),
    ]) {
      expect(() => assertNotProtectionStateMutation(target)).toThrow("Refused to modify");
    }
    expect(() => assertNotProtectionStateMutation(path.join(root, "ordinary"))).not.toThrow();
    expect(() => assertNotProtectionStateMutation(`${registry}.other`)).not.toThrow();
  });
});

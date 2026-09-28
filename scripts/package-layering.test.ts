/**
 * `@jazz/daemon` sits above `@jazz/adapters`: the daemon imports adapters, never the reverse.
 *
 * Every package except the daemon itself and the packages that compose it (`cli`, `runtime`,
 * the Astro `website`) is daemon-free: no source or test file imports `@jazz/daemon`, and no
 * package.json declares it. A new package lands on the daemon-free side unless it is added to
 * `DAEMON_CONSUMERS`. `eslint.config.mjs` enforces the same rule per import as you edit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const PACKAGES_ROOT = path.join(import.meta.dir, "..", "packages");

/** Packages allowed to import `@jazz/daemon`, plus the daemon package itself. */
const DAEMON_CONSUMERS = new Set(["daemon", "cli", "runtime", "website"]);

const DAEMON_SPECIFIER = /^(@jazz\/daemon(\/|$)|@\/daemon\/)/;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function daemonFreePackages(): string[] {
  return readdirSync(PACKAGES_ROOT).filter(
    (entry) =>
      !DAEMON_CONSUMERS.has(entry) && statSync(path.join(PACKAGES_ROOT, entry)).isDirectory(),
  );
}

describe("package layering", () => {
  it("finds the packages below the daemon", () => {
    expect(daemonFreePackages()).toEqual(expect.arrayContaining(["core", "adapters"]));
  });

  it("keeps @jazz/daemon out of every daemon-free package's imports", () => {
    const offending: string[] = [];
    for (const packageName of daemonFreePackages()) {
      const sourceRoot = path.join(PACKAGES_ROOT, packageName, "src");
      for (const file of sourceFiles(sourceRoot)) {
        const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
        for (const imported of imports) {
          if (DAEMON_SPECIFIER.test(imported.fileName)) {
            offending.push(`${path.relative(PACKAGES_ROOT, file)} imports ${imported.fileName}`);
          }
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it("keeps @jazz/daemon out of every daemon-free package's dependencies", () => {
    const offending = daemonFreePackages().filter((packageName) => {
      const manifest = JSON.parse(
        readFileSync(path.join(PACKAGES_ROOT, packageName, "package.json"), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      return ["dependencies", "devDependencies", "peerDependencies"].some(
        (field) => manifest[field]?.["@jazz/daemon"] !== undefined,
      );
    });
    expect(offending).toEqual([]);
  });
});

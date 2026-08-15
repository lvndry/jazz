import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  extractAssetsInto,
  extractEmbeddedAssets,
  hasEmbeddedAssets,
  pruneStaleAssetDirectories,
} from "./asset-extraction";
import { type EmbeddedAssetFile } from "./embedded-assets";

describe("embedded asset extraction", () => {
  const temporaryRoots: string[] = [];

  function makeTemporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-assets-"));
    temporaryRoots.push(directory);
    return directory;
  }

  function makeAssets(sourceRoot: string): EmbeddedAssetFile[] {
    fs.mkdirSync(path.join(sourceRoot, "skills", "journal"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "skills", "journal", "SKILL.md"), "# journal");
    fs.writeFileSync(path.join(sourceRoot, "notifier"), "#!/bin/sh\n");

    return [
      {
        relativePath: "skills/journal/SKILL.md",
        sourcePath: path.join(sourceRoot, "skills", "journal", "SKILL.md"),
        executable: false,
      },
      {
        relativePath: "vendor/terminal-notifier/notifier",
        sourcePath: path.join(sourceRoot, "notifier"),
        executable: true,
      },
    ];
  }

  afterEach(() => {
    while (temporaryRoots.length > 0) {
      fs.rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
    }
  });

  it("reports no embedded assets outside a standalone binary", () => {
    expect(hasEmbeddedAssets()).toBe(false);
    expect(extractEmbeddedAssets(path.join(makeTemporaryDirectory(), "0.0.0"))).toBeNull();
  });

  it("unpacks assets into their relative paths", () => {
    const sourceRoot = makeTemporaryDirectory();
    const destination = path.join(makeTemporaryDirectory(), "0.1.0");

    expect(extractAssetsInto(makeAssets(sourceRoot), destination)).toBe(destination);
    expect(fs.readFileSync(path.join(destination, "skills/journal/SKILL.md"), "utf-8")).toBe(
      "# journal",
    );
  });

  it("gives executable assets the executable bit", () => {
    const sourceRoot = makeTemporaryDirectory();
    const destination = path.join(makeTemporaryDirectory(), "0.1.0");

    extractAssetsInto(makeAssets(sourceRoot), destination);

    const notifier = fs.statSync(path.join(destination, "vendor/terminal-notifier/notifier"));
    const document = fs.statSync(path.join(destination, "skills/journal/SKILL.md"));
    expect(notifier.mode & 0o111).not.toBe(0);
    expect(document.mode & 0o111).toBe(0);
  });

  it("leaves no staging directory behind", () => {
    const sourceRoot = makeTemporaryDirectory();
    const parent = makeTemporaryDirectory();

    extractAssetsInto(makeAssets(sourceRoot), path.join(parent, "0.1.0"));

    expect(fs.readdirSync(parent)).toEqual(["0.1.0"]);
  });

  it("skips extraction when the version directory already exists", () => {
    const sourceRoot = makeTemporaryDirectory();
    const destination = path.join(makeTemporaryDirectory(), "0.1.0");
    const assets = makeAssets(sourceRoot);

    extractAssetsInto(assets, destination);
    const extractedFile = path.join(destination, "skills/journal/SKILL.md");
    fs.writeFileSync(extractedFile, "edited");

    expect(extractAssetsInto(assets, destination)).toBe(destination);
    expect(fs.readFileSync(extractedFile, "utf-8")).toBe("edited");
  });

  it("returns null when an asset cannot be read", () => {
    const destination = path.join(makeTemporaryDirectory(), "0.1.0");

    const result = extractAssetsInto(
      [{ relativePath: "skills/gone.md", sourcePath: "/nonexistent/gone.md", executable: false }],
      destination,
    );

    expect(result).toBeNull();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("prunes asset directories from other versions", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.1.0"));
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0", "skills"), { recursive: true });

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0");

    expect(fs.readdirSync(runtimeRoot)).toEqual(["0.2.0"]);
  });

  it("ignores a missing runtime directory when pruning", () => {
    expect(() =>
      pruneStaleAssetDirectories(path.join(makeTemporaryDirectory(), "absent"), "0.2.0"),
    ).not.toThrow();
  });
});

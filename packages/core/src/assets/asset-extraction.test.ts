import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  claimAssetDirectory,
  extractAssetsInto,
  extractEmbeddedAssets,
  hasEmbeddedAssets,
  pruneStaleAssetDirectories,
  UNCLAIMED_RETENTION_MS,
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

  function deadProcessId(): number {
    return Bun.spawnSync(["true"]).pid;
  }

  function claimAs(runtimeRoot: string, version: string, processId: number): void {
    fs.mkdirSync(path.join(runtimeRoot, ".in-use", version), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, ".in-use", version, String(processId)), "");
  }

  const afterRetention = () => Date.now() + UNCLAIMED_RETENTION_MS + 1;

  it("keeps an unclaimed directory on first sight and prunes it after retention", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.1.0", "personas"), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0");
    expect(fs.existsSync(path.join(runtimeRoot, "0.1.0"))).toBe(true);

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0", afterRetention());
    expect(fs.readdirSync(runtimeRoot).sort()).toEqual([".in-use", "0.2.0"]);
    expect(fs.readdirSync(path.join(runtimeRoot, ".in-use"))).toEqual([]);
  });

  it("keeps a directory claimed by a live process past retention", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.1.0"));
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));

    claimAssetDirectory(runtimeRoot, "0.1.0");
    pruneStaleAssetDirectories(runtimeRoot, "0.2.0", afterRetention());

    expect(fs.existsSync(path.join(runtimeRoot, "0.1.0"))).toBe(true);
    expect(fs.readdirSync(path.join(runtimeRoot, ".in-use", "0.1.0"))).toEqual([
      String(process.pid),
    ]);
  });

  it("prunes a directory whose only claim is from a dead process after retention", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.1.0"));
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));
    claimAs(runtimeRoot, "0.1.0", deadProcessId());

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0");
    expect(fs.existsSync(path.join(runtimeRoot, "0.1.0"))).toBe(true);

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0", afterRetention());
    expect(fs.existsSync(path.join(runtimeRoot, "0.1.0"))).toBe(false);
  });

  it("keeps a live process's staging directory and removes a dead one's", () => {
    const runtimeRoot = makeTemporaryDirectory();
    const liveStaging = `0.2.0.partial-${process.pid}`;
    const deadPruning = `0.1.0.pruning-${deadProcessId()}`;
    fs.mkdirSync(path.join(runtimeRoot, liveStaging));
    fs.mkdirSync(path.join(runtimeRoot, deadPruning));
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0");

    expect(fs.readdirSync(runtimeRoot).sort()).toEqual(["0.2.0", liveStaging]);
  });

  it("removes claims for versions that no longer have a directory", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));
    claimAs(runtimeRoot, "0.0.9", deadProcessId());

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0");

    expect(fs.readdirSync(path.join(runtimeRoot, ".in-use"))).toEqual([]);
  });

  it("leaves entries that are not version directories alone", () => {
    const runtimeRoot = makeTemporaryDirectory();
    fs.mkdirSync(path.join(runtimeRoot, "0.2.0"));
    fs.writeFileSync(path.join(runtimeRoot, "daemon-4747.status.json"), "{}");
    fs.mkdirSync(path.join(runtimeRoot, "scratch"));

    pruneStaleAssetDirectories(runtimeRoot, "0.2.0", afterRetention());

    expect(fs.readdirSync(runtimeRoot).sort()).toEqual([
      "0.2.0",
      "daemon-4747.status.json",
      "scratch",
    ]);
  });

  it("ignores a missing runtime directory when pruning", () => {
    expect(() =>
      pruneStaleAssetDirectories(path.join(makeTemporaryDirectory(), "absent"), "0.2.0"),
    ).not.toThrow();
  });
});

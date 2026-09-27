/** Source-repo plugin installs: source parsing, tree hashing, tarball extraction, and end-to-end. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createTar, createTarGzip } from "nanotar";
import {
  copySourceTree,
  DEFAULT_TARBALL_LIMITS,
  hashSourceTree,
  isLocalSourceDirectory,
  materializeGitHubSource,
  parseGitHubPluginSource,
} from "./github-source";
import { parsePluginManifest } from "./manifest-schema";
import { PluginModuleLoader } from "./module-loader";
import { PluginRegistryServiceImpl } from "./plugin-registry-service";
import { ALL_AGENTS } from "./state-store";

const SOURCE_MANIFEST = {
  schemaVersion: 1,
  id: "com.jazz.test.source",
  name: "Source test",
  version: "0.1.0",
  hostApi: 1,
  entry: "src/index.ts",
  hooks: [],
  decisionProviders: [],
  tools: [],
  commands: [],
  personas: [],
  skills: [],
  lifecycleHooks: [],
  network: { destinations: [] },
  dataSent: [],
  secrets: [],
};
const PLUGIN_ENTRY = "export default { apiVersion: 1, register() {} };\n";

async function writePluginRepo(directory: string): Promise<void> {
  await fs.mkdir(path.join(directory, "src"), { recursive: true });
  await fs.writeFile(path.join(directory, "jazz-plugin.json"), JSON.stringify(SOURCE_MANIFEST));
  await fs.writeFile(path.join(directory, "src", "index.ts"), PLUGIN_ENTRY);
}

async function githubTarball(manifest: Record<string, unknown>): Promise<Uint8Array> {
  return createTarGzip([
    { name: "owner-repo-abc/jazz-plugin.json", data: JSON.stringify(manifest) },
    { name: "owner-repo-abc/src/index.ts", data: PLUGIN_ENTRY },
  ]);
}

/** A fetch that returns each tarball in turn, so successive installs get distinct manifests. */
function sequentialFetch(...tarballs: readonly Uint8Array[]): typeof fetch {
  let call = 0;
  return (async () => {
    const body = tarballs[Math.min(call, tarballs.length - 1)];
    call += 1;
    return new Response(body as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("parseGitHubPluginSource", () => {
  test("parses owner/repo, refs, prefixes, and URLs", () => {
    expect(parseGitHubPluginSource("lvndry/jazz-plugin-warp")).toEqual({
      owner: "lvndry",
      repo: "jazz-plugin-warp",
    });
    expect(parseGitHubPluginSource("lvndry/jazz-plugin-warp@v1.2.3")).toEqual({
      owner: "lvndry",
      repo: "jazz-plugin-warp",
      ref: "v1.2.3",
    });
    expect(parseGitHubPluginSource("github:lvndry/warp")).toEqual({
      owner: "lvndry",
      repo: "warp",
    });
    expect(parseGitHubPluginSource("https://github.com/lvndry/warp.git")).toEqual({
      owner: "lvndry",
      repo: "warp",
    });
    expect(parseGitHubPluginSource("https://github.com/lvndry/warp/tree/main")).toEqual({
      owner: "lvndry",
      repo: "warp",
      ref: "main",
    });
  });

  test("rejects local paths, non-GitHub URLs, and bare names", () => {
    expect(parseGitHubPluginSource("./local/dir")).toBeUndefined();
    expect(parseGitHubPluginSource("/abs/path")).toBeUndefined();
    expect(parseGitHubPluginSource("~/dir")).toBeUndefined();
    expect(parseGitHubPluginSource("https://example.com/manifest.json")).toBeUndefined();
    expect(parseGitHubPluginSource("warp")).toBeUndefined();
  });
});

/** A raw tar header block for an entry type nanotar cannot create, such as a symlink ("2"). */
function tarHeader(name: string, typeFlag: string, linkName: string): Uint8Array {
  const block = new Uint8Array(512);
  const encoder = new TextEncoder();
  const put = (offset: number, value: string): void => {
    block.set(encoder.encode(value), offset);
  };
  put(0, name);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, "00000000000\0");
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, typeFlag);
  put(157, linkName);
  put(257, "ustar\0");
  put(263, "00");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function respondWith(body: Uint8Array, init: ResponseInit = { status: 200 }): typeof fetch {
  return (async () => new Response(body as unknown as BodyInit, init)) as unknown as typeof fetch;
}

async function extractInto(fetchImpl: typeof fetch, limits = DEFAULT_TARBALL_LIMITS) {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-extract-"));
  await materializeGitHubSource({ owner: "o", repo: "r" }, destination, fetchImpl, limits);
  return destination;
}

describe("source tree rules", () => {
  test("hashing refuses a symlink anywhere in the tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-tree-link-"));
    await writePluginRepo(root);
    await fs.symlink(path.join(os.tmpdir(), "payload.mjs"), path.join(root, "src", "helper.mjs"));
    await expect(hashSourceTree(root)).rejects.toThrow("symlink");
  });

  test("hashing refuses a FIFO", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-tree-fifo-"));
    await writePluginRepo(root);
    const made = Bun.spawnSync(["mkfifo", path.join(root, "src", "pipe")]);
    expect(made.exitCode).toBe(0);
    await expect(hashSourceTree(root)).rejects.toThrow("special file");
  });

  test("copying refuses symlinks and skips node_modules and .git by name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-tree-copy-"));
    const source = path.join(root, "source");
    await writePluginRepo(source);
    await fs.writeFile(path.join(source, ".git"), "gitdir: elsewhere\n");
    await fs.symlink(os.tmpdir(), path.join(source, "node_modules"));
    const copy = path.join(root, "copy");
    await fs.mkdir(copy);
    await copySourceTree(source, copy);
    expect(await hashSourceTree(copy)).toBe(await hashSourceTree(source));
    await expect(fs.lstat(path.join(copy, "node_modules"))).rejects.toThrow();

    await fs.symlink(path.join(root, "payload.mjs"), path.join(source, "src", "helper.mjs"));
    const second = path.join(root, "second");
    await fs.mkdir(second);
    await expect(copySourceTree(source, second)).rejects.toThrow("symlink");
  });
});

describe("hashSourceTree", () => {
  test("is deterministic and ignores node_modules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-tree-"));
    await writePluginRepo(root);
    const before = await hashSourceTree(root);
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    expect(await hashSourceTree(root)).toBe(before);
    await fs.writeFile(path.join(root, "src", "index.ts"), "changed");
    expect(await hashSourceTree(root)).not.toBe(before);
  });
});

describe("materializeGitHubSource", () => {
  test("extracts a tarball, stripping the top-level directory", async () => {
    const tarball = await createTarGzip([
      { name: "lvndry-warp-abc123/jazz-plugin.json", data: JSON.stringify(SOURCE_MANIFEST) },
      { name: "lvndry-warp-abc123/src/index.ts", data: PLUGIN_ENTRY },
    ]);
    const fetchImpl = (async () =>
      new Response(tarball as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-extract-"));
    await materializeGitHubSource({ owner: "lvndry", repo: "warp" }, destination, fetchImpl);
    expect(await fs.readFile(path.join(destination, "src", "index.ts"), "utf8")).toBe(PLUGIN_ENTRY);
    expect(await isLocalSourceDirectory(destination)).toBe(true);
  });

  test("follows the API redirect to codeload and refuses one to any other origin", async () => {
    const tarball = await githubTarball(SOURCE_MANIFEST);
    const redirectingTo = (location: string): typeof fetch =>
      (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === "api.github.com") {
          return new Response(null, { status: 302, headers: { location } });
        }
        return new Response(tarball as unknown as BodyInit, { status: 200 });
      }) as unknown as typeof fetch;

    const destination = await extractInto(
      redirectingTo("https://codeload.github.com/o/r/legacy.tar.gz/refs/heads/main"),
    );
    expect(await isLocalSourceDirectory(destination)).toBe(true);
    await expect(extractInto(redirectingTo("https://evil.example/r.tar.gz"))).rejects.toThrow(
      "outside its trusted HTTPS origin",
    );
    await expect(
      extractInto(redirectingTo("http://codeload.github.com/o/r/legacy.tar.gz")),
    ).rejects.toThrow("outside its trusted HTTPS origin");
  });

  test("caps the compressed download by declared length and while streaming", async () => {
    const tarball = await githubTarball(SOURCE_MANIFEST);
    const limits = { ...DEFAULT_TARBALL_LIMITS, maxDownloadBytes: tarball.byteLength - 1 };
    await expect(extractInto(respondWith(tarball), limits)).rejects.toThrow("Download exceeds");

    const streamed = (): Response =>
      new Response(new Blob([tarball as BlobPart]).stream(), { status: 200 });
    expect(streamed().headers.get("content-length")).toBeNull();
    const undeclared = (async () => streamed()) as unknown as typeof fetch;
    await expect(extractInto(undeclared, limits)).rejects.toThrow("Download exceeds");
  });

  test("caps the inflated size so a small tarball cannot expand without bound", async () => {
    const bomb = await createTarGzip([
      { name: "owner-repo-abc/jazz-plugin.json", data: JSON.stringify(SOURCE_MANIFEST) },
      { name: "owner-repo-abc/padding.bin", data: new Uint8Array(4 * 1024 * 1024) },
    ]);
    const limits = { ...DEFAULT_TARBALL_LIMITS, maxExtractedBytes: 1024 * 1024 };
    expect(bomb.byteLength).toBeLessThan(limits.maxExtractedBytes);
    await expect(extractInto(respondWith(bomb), limits)).rejects.toThrow("expands past");
  });

  test("times out a download that never finishes", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const limits = { ...DEFAULT_TARBALL_LIMITS, timeoutMs: 20 };
    await expect(extractInto(hanging, limits)).rejects.toThrow();
  });

  test("refuses symlink and hard-link entries", async () => {
    for (const [typeFlag, label] of [
      ["2", "symbolicLink"],
      ["1", "hardLink"],
    ] as const) {
      const regular = createTar([
        { name: "owner-repo-abc/jazz-plugin.json", data: JSON.stringify(SOURCE_MANIFEST) },
      ]);
      const link = tarHeader("owner-repo-abc/src/helper.mjs", typeFlag, "/etc/passwd");
      const archive = new Uint8Array(512 + regular.byteLength);
      archive.set(link, 0);
      archive.set(regular, 512);
      await expect(extractInto(respondWith(Bun.gzipSync(archive)))).rejects.toThrow(
        `contains a ${label} entry`,
      );
    }
  });

  test("throws on a non-200 response", async () => {
    const fetchImpl = (async () =>
      new Response("no" as unknown as BodyInit, { status: 404 })) as unknown as typeof fetch;
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-extract-"));
    await expect(
      materializeGitHubSource({ owner: "o", repo: "r" }, destination, fetchImpl),
    ).rejects.toThrow("GitHub returned 404");
  });
});

describe("source-repo install lifecycle", () => {
  test("installs from a local source dir, then trusts, enables, and loads it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-install-"));
    const repo = path.join(root, "plugin-repo");
    await writePluginRepo(repo);
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });

    const added = await registry.addFromSource({ localDirectory: repo });
    expect(added.action).toBe("added");

    const installed = await registry.inspect("com.jazz.test.source");
    expect(installed.current.kind).toBe("source");
    expect(installed.artifactValid).toBe(true);
    expect(installed.trusted).toBe(false);

    await registry.trust("com.jazz.test.source", added.digest!);
    const consent = await registry.inspect("com.jazz.test.source");
    await registry.grantConsent("com.jazz.test.source", consent.consentDigest);
    await registry.enable("com.jazz.test.source", "default");

    const loader = new PluginModuleLoader({
      stateStore: registry.stateStore,
      installer: registry.installer,
    });
    const loaded = await loader.loadEnabledForAgent("default");
    expect(loaded.map((plugin) => plugin.manifest.id)).toEqual(["com.jazz.test.source"]);
    expect(loaded[0]?.module.apiVersion).toBe(1);
  });

  test("resolves the owner/repo used to install to the plugin id for management commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-resolve-"));
    const tarball = await createTarGzip([
      {
        name: "lvndry-jazz-plugin-warp-abc/jazz-plugin.json",
        data: JSON.stringify(SOURCE_MANIFEST),
      },
      { name: "lvndry-jazz-plugin-warp-abc/src/index.ts", data: PLUGIN_ENTRY },
    ]);
    const fetchImpl = (async () =>
      new Response(tarball as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const registry = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
      fetchImpl,
    });
    const added = await registry.addFromSource({
      github: { owner: "lvndry", repo: "jazz-plugin-warp" },
    });

    // The same owner/repo used with `add` resolves to the installed id.
    expect((await registry.inspect("lvndry/jazz-plugin-warp")).id).toBe("com.jazz.test.source");
    await registry.trust("lvndry/jazz-plugin-warp", added.digest!);
    expect((await registry.inspect("com.jazz.test.source")).trusted).toBe(true);

    // A github URL and @ref form resolve to the same plugin.
    expect((await registry.inspect("https://github.com/lvndry/jazz-plugin-warp")).id).toBe(
      "com.jazz.test.source",
    );
  });

  test("drives the full lifecycle through an owner/repo alias, pinned to the canonical id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-alias-"));
    const registry = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
      fetchImpl: sequentialFetch(await githubTarball(SOURCE_MANIFEST)),
    });
    const alias = "lvndry/jazz-plugin-warp";
    const added = await registry.addFromSource({
      github: { owner: "lvndry", repo: "jazz-plugin-warp" },
    });

    await registry.trust(alias, added.digest!);
    const consent = await registry.inspect(alias);
    await registry.grantConsent(alias, consent.consentDigest);
    const enabled = await registry.enable(alias, "default");
    expect(enabled.pluginId).toBe("com.jazz.test.source");
    expect((await registry.inspect("com.jazz.test.source")).enabledAgentIds).toEqual(["default"]);

    // A mutating command via the alias resolves to and reports the canonical id.
    const disabled = await registry.disable(alias, "default");
    expect(disabled.pluginId).toBe("com.jazz.test.source");
    expect((await registry.inspect("com.jazz.test.source")).enabledAgentIds).toEqual([]);

    // The secret path resolves to the canonical plugin before any keyring access.
    await expect(registry.setSecret(alias, "TOKEN", "x")).rejects.toThrow(
      "com.jazz.test.source did not declare secret",
    );

    const removed = await registry.remove(alias);
    expect(removed.pluginId).toBe("com.jazz.test.source");
  });

  test("update re-fetches a GitHub source install and keeps the previous digest for rollback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-update-"));
    const second = await createTarGzip([
      { name: "owner-repo-def/jazz-plugin.json", data: JSON.stringify(SOURCE_MANIFEST) },
      {
        name: "owner-repo-def/src/index.ts",
        data: "export default { apiVersion: 1, register() { /* v2 */ } };\n",
      },
    ]);
    const registry = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
      fetchImpl: sequentialFetch(await githubTarball(SOURCE_MANIFEST), second),
    });
    const added = await registry.addFromSource({
      github: { owner: "lvndry", repo: "jazz-plugin-warp" },
    });

    // No explicit source: the CLI passes the recorded source, so update re-pulls the same repo.
    const updated = await registry.update("lvndry/jazz-plugin-warp", "lvndry/jazz-plugin-warp");
    expect(updated.action).toBe("updated");
    expect(updated.digest).not.toBe(added.digest);

    const inspection = await registry.inspect("com.jazz.test.source");
    expect(inspection.current.kind).toBe("source");
    expect(inspection.current.manifest.sha256).toBe(updated.digest!);
    expect(inspection.previous?.manifest.sha256).toBe(added.digest!);
  });

  test("fails closed when an owner/repo alias is ambiguous across installs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-ambiguous-"));
    const registry = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
      fetchImpl: sequentialFetch(
        await githubTarball({ ...SOURCE_MANIFEST, id: "com.jazz.test.a" }),
        await githubTarball({ ...SOURCE_MANIFEST, id: "com.jazz.test.b" }),
      ),
    });
    await registry.addFromSource({ github: { owner: "acme", repo: "multi" } });
    await registry.addFromSource({ github: { owner: "acme", repo: "multi" } });

    await expect(registry.inspect("acme/multi")).rejects.toThrow("ambiguous");
    // The exact plugin id still resolves unambiguously.
    expect((await registry.inspect("com.jazz.test.a")).id).toBe("com.jazz.test.a");
  });

  test("enabling globally loads the plugin for any agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-global-"));
    const repo = path.join(root, "plugin-repo");
    await writePluginRepo(repo);
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    const added = await registry.addFromSource({ localDirectory: repo });
    await registry.trust("com.jazz.test.source", added.digest!);
    const consent = await registry.inspect("com.jazz.test.source");
    await registry.grantConsent("com.jazz.test.source", consent.consentDigest);
    await registry.enable("com.jazz.test.source", ALL_AGENTS);

    expect((await registry.inspect("com.jazz.test.source")).enabledAgentIds).toEqual([ALL_AGENTS]);
    const loader = new PluginModuleLoader({
      stateStore: registry.stateStore,
      installer: registry.installer,
    });
    const loaded = await loader.loadEnabledForAgent("an-agent-never-enabled-explicitly");
    expect(loaded.map((plugin) => plugin.manifest.id)).toEqual(["com.jazz.test.source"]);
  });

  test("verification fails if the installed source tree is tampered with", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-source-tamper-"));
    const repo = path.join(root, "plugin-repo");
    await writePluginRepo(repo);
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    const added = await registry.addFromSource({ localDirectory: repo });
    await registry.trust("com.jazz.test.source", added.digest!);
    const consent = await registry.inspect("com.jazz.test.source");
    await registry.grantConsent("com.jazz.test.source", consent.consentDigest);
    await registry.enable("com.jazz.test.source", "default");

    await fs.writeFile(
      path.join(root, "plugins", "sources", added.digest!, "src", "index.ts"),
      "export default { apiVersion: 1, register() { /* tampered */ } };\n",
    );

    const loader = new PluginModuleLoader({
      stateStore: registry.stateStore,
      installer: registry.installer,
    });
    await expect(loader.loadEnabledForAgent("default")).rejects.toThrow(
      "failed digest verification",
    );
  });
});

const PLUGIN_ID = "com.jazz.test.source";

async function trustConsentEnable(registry: PluginRegistryServiceImpl, digest: string) {
  await registry.trust(PLUGIN_ID, digest);
  const consent = await registry.inspect(PLUGIN_ID);
  await registry.grantConsent(PLUGIN_ID, consent.consentDigest);
  await registry.enable(PLUGIN_ID, "default");
}

function loaderFor(registry: PluginRegistryServiceImpl): PluginModuleLoader {
  return new PluginModuleLoader({ stateStore: registry.stateStore, installer: registry.installer });
}

/**
 * Commit a tree and its state record directly, the way a store written before the install-time
 * checks existed can hold one, so the load-time checks are exercised on their own.
 */
async function writeUnscannedSourceRecord(
  registry: PluginRegistryServiceImpl,
  tree: string,
  entry: string,
): Promise<string> {
  const digest = await hashSourceTree(tree);
  const sourceRoot = registry.installer.sourcePath(digest);
  await fs.mkdir(path.dirname(sourceRoot), { recursive: true });
  await fs.cp(tree, sourceRoot, { recursive: true });
  const { entry: _entry, ...metadata } = SOURCE_MANIFEST;
  const manifest = parsePluginManifest({ ...metadata, artifact: entry, sha256: digest });
  await registry.stateStore.transact((state) => ({
    state: {
      ...state,
      plugins: {
        ...state.plugins,
        [PLUGIN_ID]: {
          current: {
            manifest,
            source: "file:///legacy",
            artifactPath: path.join(sourceRoot, entry),
            installedAt: new Date().toISOString(),
            kind: "source" as const,
          },
          trustedDigests: [],
          consentGrants: [],
          enabledAgentIds: [],
          enabledForAllAgents: false,
          activatedDigests: [],
          storedSecretNames: [],
        },
      },
    },
    result: undefined,
  }));
  return digest;
}

describe("source install integrity", () => {
  test("an entry outside the tree is refused at install, and at load when swapped after trust", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-integrity-entry-"));
    const pluginDirectory = path.join(root, "home", "plugins");
    const outside = path.join(root, "outside.mjs");
    await fs.writeFile(outside, PLUGIN_ENTRY);
    const repo = path.join(root, "repo");
    await writePluginRepo(repo);
    await fs.writeFile(
      path.join(repo, "jazz-plugin.json"),
      JSON.stringify({ ...SOURCE_MANIFEST, entry: "../../../../outside.mjs" }),
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory });
    await expect(registry.addFromSource({ localDirectory: repo })).rejects.toThrow(
      "entry must be a safe relative path",
    );

    const digest = await writeUnscannedSourceRecord(registry, repo, "../../../../outside.mjs");
    expect((await registry.inspect(PLUGIN_ID)).artifactValid).toBe(false);
    await trustConsentEnable(registry, digest);
    await fs.writeFile(outside, "globalThis.swappedAfterTrust = true;\n" + PLUGIN_ENTRY);
    await expect(loaderFor(registry).loadEnabledForAgent("default")).rejects.toThrow(
      "entry must be a safe relative path",
    );
    expect((globalThis as Record<string, unknown>)["swappedAfterTrust"]).toBeUndefined();
  });

  test("a symlinked helper is refused at install, and at load when swapped in after trust", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-integrity-link-"));
    const pluginDirectory = path.join(root, "home", "plugins");
    const payload = path.join(root, "payload.mjs");
    await fs.writeFile(payload, "export {};\n");
    const repo = path.join(root, "repo");
    await writePluginRepo(repo);
    await fs.writeFile(
      path.join(repo, "src", "index.ts"),
      `import "./helper.mjs";\n${PLUGIN_ENTRY}`,
    );
    await fs.symlink(payload, path.join(repo, "src", "helper.mjs"));
    const registry = new PluginRegistryServiceImpl({ pluginDirectory });
    await expect(registry.addFromSource({ localDirectory: repo })).rejects.toThrow("symlink");

    await fs.rm(path.join(repo, "src", "helper.mjs"));
    await fs.writeFile(path.join(repo, "src", "helper.mjs"), "export {};\n");
    const added = await registry.addFromSource({ localDirectory: repo });
    expect((await registry.inspect(PLUGIN_ID)).artifactValid).toBe(true);
    await trustConsentEnable(registry, added.digest!);

    const committedHelper = path.join(
      registry.installer.sourcePath(added.digest!),
      "src",
      "helper.mjs",
    );
    await fs.rm(committedHelper);
    await fs.writeFile(payload, "globalThis.symlinkPayloadRan = true;\n");
    await fs.symlink(payload, committedHelper);
    expect((await registry.inspect(PLUGIN_ID)).artifactValid).toBe(false);
    await expect(loaderFor(registry).loadEnabledForAgent("default")).rejects.toThrow("symlink");
    expect((globalThis as Record<string, unknown>)["symlinkPayloadRan"]).toBeUndefined();
  });

  test("an import outside the tree is refused at install, and at load for an unscanned record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-integrity-import-"));
    const pluginDirectory = path.join(root, "home", "plugins");
    const payload = path.join(root, "payload.mjs");
    await fs.writeFile(payload, "export {};\n");
    const repo = path.join(root, "repo");
    await writePluginRepo(repo);
    await fs.writeFile(
      path.join(repo, "src", "index.ts"),
      `import ${JSON.stringify(payload)};\n${PLUGIN_ENTRY}`,
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory });
    await expect(registry.addFromSource({ localDirectory: repo })).rejects.toThrow(
      "resolves outside the plugin directory",
    );

    const digest = await writeUnscannedSourceRecord(registry, repo, "src/index.ts");
    expect((await registry.inspect(PLUGIN_ID)).artifactValid).toBe(false);
    await trustConsentEnable(registry, digest);
    await fs.writeFile(payload, "globalThis.outsideImportRan = true;\n");
    await expect(loaderFor(registry).loadEnabledForAgent("default")).rejects.toThrow(
      "resolves outside the plugin directory",
    );
    expect((globalThis as Record<string, unknown>)["outsideImportRan"]).toBeUndefined();
  });
});

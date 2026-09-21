/** Source-repo plugin installs: source parsing, tree hashing, tarball extraction, and end-to-end. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createTarGzip } from "nanotar";
import {
  hashSourceTree,
  isLocalSourceDirectory,
  materializeGitHubSource,
  parseGitHubPluginSource,
} from "./github-source";
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

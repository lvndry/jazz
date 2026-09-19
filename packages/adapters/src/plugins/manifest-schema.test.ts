/** Exercises untrusted manifest parsing and bounded artifact acquisition. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { acquirePluginManifest, PluginArtifactInstaller } from "./artifact-installer";
import { parsePluginManifest } from "./manifest-schema";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.jazz.test.router",
    name: "Test router",
    version: "1.0.0",
    hostApi: 1,
    artifact: "./plugin.mjs",
    sha256: "a".repeat(64),
    hooks: ["route.skills"],
    policyHooks: [],
    decisionProviders: ["test"],
    network: { destinations: ["API.Example.com:443"] },
    dataSent: ["turn.request_text"],
    secrets: [{ name: "API_KEY", env: "TEST_API_KEY", required: true, description: "Test key" }],
    ...overrides,
  };
}

describe("parsePluginManifest", () => {
  test("normalizes a complete strict manifest", () => {
    const parsed = parsePluginManifest(manifest());
    expect(parsed.id).toBe("com.jazz.test.router");
    expect(parsed.network.destinations).toEqual(["api.example.com"]);
    expect(parsed.secrets[0]?.name).toBe("API_KEY");
  });

  test("accepts lower-camel secret names while keeping environment names uppercase", () => {
    const parsed = parsePluginManifest(
      manifest({
        secrets: [{ name: "apiKey", env: "TEST_API_KEY", required: true, description: "Test key" }],
      }),
    );
    expect(parsed.secrets[0]?.name).toBe("apiKey");
    expect(() =>
      parsePluginManifest(
        manifest({
          secrets: [{ name: "apiKey", env: "apiKey", required: true, description: "Test key" }],
        }),
      ),
    ).toThrow("env has an invalid format");
  });

  test("rejects unknown fields and malformed digests", () => {
    expect(() => parsePluginManifest(manifest({ surprise: true }))).toThrow("unknown field");
    expect(() => parsePluginManifest(manifest({ sha256: "ABC" }))).toThrow("64 lowercase hex");
  });

  test("parses policy hooks separately from advisory hooks", () => {
    expect(
      parsePluginManifest(manifest({ policyHooks: ["classify.command-risk"] })).policyHooks,
    ).toEqual(["classify.command-risk"]);
    expect(() => parsePluginManifest(manifest({ policyHooks: ["route.skills"] }))).toThrow(
      "Unknown policy hook",
    );
    expect(() => parsePluginManifest(manifest({ hooks: ["classify.command-risk"] }))).toThrow(
      "Unknown advisory hook",
    );
  });

  test("rejects wildcard, URL-shaped, and local destinations", () => {
    for (const destination of ["*.example.com", "https://example.com", "localhost"]) {
      expect(() =>
        parsePluginManifest(manifest({ network: { destinations: [destination] } })),
      ).toThrow();
    }
  });
});

describe("PluginArtifactInstaller", () => {
  test("installs verified local regular files at a digest-addressed path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-artifact-"));
    const source = path.join(root, "source");
    const pluginDirectory = path.join(root, "installed");
    await fs.mkdir(source);
    const bytes = "export default { apiVersion: 1, register() {} };\n";
    const digest = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(source, "plugin.mjs"), bytes);
    await fs.writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify(manifest({ sha256: digest, secrets: [] })),
    );
    const acquired = await acquirePluginManifest(path.join(source, "manifest.json"));
    const installer = new PluginArtifactInstaller({ pluginDirectory });
    const installed = await installer.install(acquired.manifest, acquired.source);
    expect(installed).toBe(path.join(pluginDirectory, "artifacts", digest, "plugin.mjs"));
    expect(await installer.verify(digest)).toBe(true);
    expect((await fs.stat(installed)).mode & 0o777).toBe(0o600);
  });

  test("rejects local traversal and symlink artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-artifact-"));
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const outside = path.join(root, "outside.mjs");
    await fs.writeFile(outside, "export default {};");
    const digest = createHash("sha256").update("export default {};").digest("hex");
    const installer = new PluginArtifactInstaller({
      pluginDirectory: path.join(root, "installed"),
    });

    const escaping = parsePluginManifest(
      manifest({ artifact: "../outside.mjs", sha256: digest, secrets: [] }),
    );
    await expect(
      installer.install(escaping, new URL(`file://${source}/manifest.json`)),
    ).rejects.toThrow("escapes manifest directory");

    await fs.symlink(outside, path.join(source, "plugin.mjs"));
    const linked = parsePluginManifest(manifest({ sha256: digest, secrets: [] }));
    await expect(
      installer.install(linked, new URL(`file://${source}/manifest.json`)),
    ).rejects.toThrow("resolves outside manifest directory");
  });

  test("rejects cross-origin redirects before reading an artifact", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/plugin.mjs" },
      })) as unknown as typeof fetch;
    await expect(
      acquirePluginManifest("https://catalog.example/manifest.json", fetchImpl),
    ).rejects.toThrow("outside its trusted HTTPS origin");
  });
});

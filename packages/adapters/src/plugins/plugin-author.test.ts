/** Verifies scaffold, strict packing, registration audit, and disposable development probing. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parsePluginManifest } from "./manifest-schema";
import {
  SCAFFOLD_BUN_VERSION,
  SCAFFOLD_PLUGIN_SDK_VERSION,
  devPlugin,
  packPlugin,
  probePackedPlugin,
  scaffoldPlugin,
} from "./plugin-author";

describe("packPlugin", () => {
  test("emits a validated, digest-matching standalone plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-pack-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src/index.ts"),
      "export default { apiVersion: 1, register() {} } as const;\n",
    );
    await fs.writeFile(
      path.join(root, "jazz-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.test.pack",
        name: "Pack test",
        version: "1.0.0",
        hostApi: 1,
        hooks: [],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );

    const packed = await packPlugin({ pluginDirectory: root });
    const manifest = parsePluginManifest(await fs.readFile(packed.catalogEntryPath, "utf8"));
    expect(manifest.sha256).toBe(packed.sha256);
    expect(await fs.readFile(packed.digestPath, "utf8")).toBe(`${packed.sha256}  plugin.mjs\n`);
  });

  test("rejects an opaque runtime import", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-pack-dynamic-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src/index.ts"),
      'const target = process.env["PLUGIN_IMPORT"]; if (target) await import(target); export default { apiVersion: 1, register() {} };\n',
    );
    await fs.writeFile(
      path.join(root, "jazz-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.test.dynamic",
        name: "Dynamic test",
        version: "1.0.0",
        hostApi: 1,
        hooks: [],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );
    await expect(packPlugin({ pluginDirectory: root })).rejects.toThrow();
  });

  test("scaffolds exact toolchain pins and dev-runs the declared hook", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-scaffold-"));
    const directory = path.join(parent, "my-router");
    await scaffoldPlugin({ directory });
    const packageJson = JSON.parse(
      await fs.readFile(path.join(directory, "package.json"), "utf8"),
    ) as {
      packageManager: string;
      devDependencies: Record<string, string>;
    };
    expect(packageJson.packageManager).toBe(`bun@${SCAFFOLD_BUN_VERSION}`);
    expect(packageJson.devDependencies["@jazz/plugin-sdk"]).toBe(SCAFFOLD_PLUGIN_SDK_VERSION);

    const result = await devPlugin({
      pluginDirectory: directory,
      routeSkillsInput: {
        requestText: "test",
        skills: [{ name: "testing", description: "Test things" }],
      },
    });
    expect(result.registeredHooks).toEqual(["route.skills"]);
    expect(result.routeSkillsOutcome?.status).toBe("answered");
  });

  test("probe rejects registrations missing from the packed declaration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-probe-declaration-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "src/index.ts"),
      "export default { apiVersion: 1, register() {} } as const;\n",
    );
    await fs.writeFile(
      path.join(root, "jazz-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.test.probe",
        name: "Probe test",
        version: "1.0.0",
        hostApi: 1,
        hooks: ["route.skills"],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );
    const packed = await packPlugin({ pluginDirectory: root });
    await expect(probePackedPlugin({ manifestPath: packed.catalogEntryPath })).rejects.toThrow(
      "registrations do not match manifest",
    );
  });
});

/** Import-graph confinement: the digest-covered directory is the only code a plugin may import. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { hashSourceTree } from "./github-source";
import { scanPluginImportGraph, verifySourceInstall } from "./source-integrity";

const temporaryRoots: string[] = [];

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-import-graph-"));
  temporaryRoots.push(base);
  const root = path.join(base, "plugin");
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const MODULE = "export default { apiVersion: 1, register() {} };\n";

describe("scanPluginImportGraph", () => {
  test("follows in-tree imports, re-exports, requires, and literal dynamic imports", async () => {
    const root = await makeTree({
      "src/index.ts": [
        'import { readFile } from "node:fs/promises";',
        'import { spawn } from "child_process";',
        'import type { JazzPluginModule } from "@jazz/plugin-sdk";',
        'import { helper } from "./helper";',
        'export * from "./reexport.mjs";',
        'const lazy = () => import("./lazy.js");',
        'const data = require("./data.json");',
        MODULE,
      ].join("\n"),
      "src/helper.ts": 'import "../shared/util.ts";\nexport const helper = 1;\n',
      "src/reexport.mjs": "export const other = 2;\n",
      "src/lazy.js": "export const later = 3;\n",
      "src/data.json": "{}",
      "shared/util.ts": "export {};\n",
    });
    const visited = await scanPluginImportGraph(root, "src/index.ts");
    expect([...visited].sort()).toEqual([
      "shared/util.ts",
      "src/data.json",
      "src/helper.ts",
      "src/index.ts",
      "src/lazy.js",
      "src/reexport.mjs",
    ]);
  });

  test("refuses a relative import that climbs out of the tree", async () => {
    const root = await makeTree({ "src/index.mjs": `import "../../outside.mjs";\n${MODULE}` });
    await fs.writeFile(path.join(root, "..", "outside.mjs"), "export {};\n");
    await expect(scanPluginImportGraph(root, "src/index.mjs")).rejects.toThrow(
      "resolves outside the plugin directory",
    );
  });

  test("refuses an absolute import of a file outside the tree", async () => {
    const root = await makeTree({ "src/index.mjs": MODULE });
    const outside = path.join(root, "..", "payload.mjs");
    await fs.writeFile(outside, "export {};\n");
    await fs.writeFile(
      path.join(root, "src/index.mjs"),
      `import ${JSON.stringify(outside)};\n${MODULE}`,
    );
    await expect(scanPluginImportGraph(root, "src/index.mjs")).rejects.toThrow(
      "resolves outside the plugin directory",
    );
  });

  test("refuses a dynamic import that reaches outside the tree", async () => {
    const root = await makeTree({
      "src/index.ts": `export const load = () => import("../../outside.mjs");\n${MODULE}`,
    });
    await fs.writeFile(path.join(root, "..", "outside.mjs"), "export {};\n");
    await expect(scanPluginImportGraph(root, "src/index.ts")).rejects.toThrow(
      "resolves outside the plugin directory",
    );
  });

  test("refuses package imports, which resolve through unhashed node_modules", async () => {
    const root = await makeTree({ "src/index.ts": `import "left-pad";\n${MODULE}` });
    const parentModules = path.join(root, "..", "node_modules", "left-pad");
    await fs.mkdir(parentModules, { recursive: true });
    await fs.writeFile(path.join(parentModules, "index.js"), "module.exports = 1;\n");
    await expect(scanPluginImportGraph(root, "src/index.ts")).rejects.toThrow(
      "imports package left-pad",
    );
  });

  test("refuses a runtime import of the types-only SDK", async () => {
    const root = await makeTree({
      "src/index.ts": `import { PLUGIN_API_VERSION } from "@jazz/plugin-sdk";\nexport default { apiVersion: PLUGIN_API_VERSION, register() {} };\n`,
    });
    await expect(scanPluginImportGraph(root, "src/index.ts")).rejects.toThrow(
      "import the SDK with `import type`",
    );
  });

  test("refuses a tsconfig path alias that points outside the tree", async () => {
    const root = await makeTree({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "lib/*": ["../vendor/*"] } },
      }),
      "src/index.ts": `import "lib/payload";\n${MODULE}`,
    });
    await fs.mkdir(path.join(root, "..", "vendor"), { recursive: true });
    await fs.writeFile(path.join(root, "..", "vendor", "payload.ts"), "export {};\n");
    await expect(scanPluginImportGraph(root, "src/index.ts")).rejects.toThrow(
      "imports package lib/payload",
    );
  });

  test("follows a tsconfig path alias that stays inside the tree", async () => {
    const root = await makeTree({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/index.ts": `import { value } from "@/util";\n${MODULE}`,
      "src/util.ts": "export const value = 1;\n",
    });
    expect([...(await scanPluginImportGraph(root, "src/index.ts"))].sort()).toEqual([
      "src/index.ts",
      "src/util.ts",
    ]);
  });

  test("refuses the implicit JSX runtime import, which is a package import", async () => {
    const root = await makeTree({ "src/index.js": `export const view = <div />;\n${MODULE}` });
    await expect(scanPluginImportGraph(root, "src/index.js")).rejects.toThrow(
      "imports package react",
    );
  });

  test("refuses an entry that is a symlink to a file outside the tree", async () => {
    const root = await makeTree({ "src/other.ts": MODULE });
    const outside = path.join(root, "..", "outside.mjs");
    await fs.writeFile(outside, MODULE);
    await fs.symlink(outside, path.join(root, "src/index.mjs"));
    await expect(scanPluginImportGraph(root, "src/index.mjs")).rejects.toThrow(
      "resolves outside the plugin directory",
    );
  });

  test("refuses an entry that does not exist or is a directory", async () => {
    const root = await makeTree({ "src/lib/index.ts": MODULE });
    await expect(scanPluginImportGraph(root, "src/missing.ts")).rejects.toThrow("does not exist");
    await expect(scanPluginImportGraph(root, "src/lib")).rejects.toThrow("not a regular file");
  });
});

describe("verifySourceInstall", () => {
  test("accepts an intact tree and refuses a traversal entry built by the same path join", async () => {
    const root = await makeTree({ "src/index.ts": MODULE });
    const digest = await hashSourceTree(root);
    await verifySourceInstall({
      sourceRoot: root,
      entry: "src/index.ts",
      digest,
      artifactPath: path.join(root, "src/index.ts"),
    });

    const escaping = "../../outside.mjs";
    await expect(
      verifySourceInstall({
        sourceRoot: root,
        entry: escaping,
        digest,
        artifactPath: path.join(root, escaping),
      }),
    ).rejects.toThrow("entry must be a safe relative path");
  });

  test("refuses an entry path recorded somewhere other than under the digest root", async () => {
    const root = await makeTree({ "src/index.ts": MODULE });
    await expect(
      verifySourceInstall({
        sourceRoot: root,
        entry: "src/index.ts",
        digest: await hashSourceTree(root),
        artifactPath: path.join(root, "..", "elsewhere.ts"),
      }),
    ).rejects.toThrow("not digest-addressed");
  });
});

/**
 * Author-side plugin packaging for CLI and catalog automation.
 *
 * A source tree is bundled into one dependency-inlined ESM artifact, imported
 * once to validate the ABI, hashed, and accompanied by an install manifest.
 * Emitted assets, native modules, code splitting, and package imports left for
 * runtime resolution are rejected.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createPluginSession } from "@jazz/core/agent/plugins/plugin-session";
import type {
  JazzPluginModule,
  PluginHostApi,
  PluginManifest,
  SkillRouteInput,
  SkillRouteOutcome,
} from "@jazz/core/types/plugin";
import { Effect } from "effect";
import { PluginArtifactInstaller, acquirePluginManifest } from "./artifact-installer";
import { parsePluginManifest } from "./manifest-schema";

const NATIVE_OR_ASSET_INPUT =
  /\.(?:node|wasm|css|html|sqlite|db|png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i;
const BUILTIN_IMPORT = /^(?:node:|bun:)/;

interface SourceManifest {
  readonly schemaVersion?: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: 1;
  readonly entry?: string;
  readonly hooks: readonly string[];
  readonly decisionProviders: readonly string[];
  readonly network: { readonly destinations: readonly string[] };
  readonly dataSent: readonly string[];
  readonly secrets: readonly unknown[];
}

export interface PackPluginOptions {
  readonly pluginDirectory: string;
  readonly releaseDirectory?: string;
}

export interface PackedPlugin {
  readonly artifactPath: string;
  readonly digestPath: string;
  readonly catalogEntryPath: string;
  readonly sha256: string;
}

export interface ScaffoldPluginOptions {
  readonly directory: string;
  readonly pluginId?: string;
  readonly displayName?: string;
}

export interface ProbePackedPluginOptions {
  readonly manifestPath: string;
  readonly routeSkillsInput?: SkillRouteInput;
}

export interface PluginProbeResult {
  readonly manifest: PluginManifest;
  readonly registeredHooks: readonly string[];
  readonly registeredDecisionProviders: readonly string[];
  readonly registeredTools: readonly string[];
  readonly registeredCommands: readonly string[];
  readonly registeredLifecycleEvents: readonly string[];
  readonly routeSkillsOutcome?: SkillRouteOutcome;
}

export interface DevPluginOptions {
  readonly pluginDirectory: string;
  readonly routeSkillsInput?: SkillRouteInput;
}

export const SCAFFOLD_PLUGIN_SDK_VERSION = "0.1.0";
export const SCAFFOLD_BUN_VERSION = "1.4.0";
export const SCAFFOLD_BUN_TYPES_VERSION = "1.4.2";

function fail(message: string): never {
  throw new Error(`Cannot pack Jazz plugin: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("jazz-plugin.json must contain an object");
  }
  return value as Record<string, unknown>;
}

async function readSourceManifest(pluginDirectory: string): Promise<SourceManifest> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      await fs.readFile(path.join(pluginDirectory, "jazz-plugin.json"), "utf8"),
    ) as unknown;
  } catch (error) {
    fail(`invalid jazz-plugin.json (${error instanceof Error ? error.message : String(error)})`);
  }
  const source = record(decoded);
  const allowed = new Set([
    "schemaVersion",
    "id",
    "name",
    "version",
    "hostApi",
    "entry",
    "hooks",
    "decisionProviders",
    "tools",
    "commands",
    "personas",
    "skills",
    "lifecycleHooks",
    "claimsNotifications",
    "network",
    "dataSent",
    "secrets",
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`manifest contains unknown field(s): ${unknown.join(", ")}`);
  // Reuse the install boundary for all metadata by supplying pack-generated fields.
  const { entry: _entry, ...installMetadata } = source;
  parsePluginManifest({
    ...installMetadata,
    schemaVersion: source["schemaVersion"] ?? 1,
    artifact: "./plugin.mjs",
    sha256: "0".repeat(64),
  });
  if (source["entry"] !== undefined && typeof source["entry"] !== "string") {
    fail("entry must be a string");
  }
  return source as unknown as SourceManifest;
}

export interface PreparedSourceManifest {
  readonly manifest: PluginManifest;
  readonly entry: string;
}

/**
 * Read a plugin's authoring manifest and synthesize the install manifest for a source install,
 * binding it to a source-tree `digest`. The entry path replaces the packed artifact reference; no
 * bundling or code execution occurs.
 */
export async function prepareSourceManifest(
  pluginDirectory: string,
  digest: string,
): Promise<PreparedSourceManifest> {
  const source = await readSourceManifest(pluginDirectory);
  const entry = source.entry ?? "src/index.ts";
  const { entry: _entry, ...installMetadata } = source as unknown as Record<string, unknown>;
  const manifest = parsePluginManifest({
    ...installMetadata,
    schemaVersion: source.schemaVersion ?? 1,
    artifact: entry,
    sha256: digest,
  });
  return { manifest, entry };
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`path escapes plugin directory: ${relativePath}`);
  }
  return resolved;
}

function inspectBuild(result: Bun.BuildOutput): Bun.BuildArtifact {
  if (!result.success) fail(result.logs.map((log) => log.message).join("\n") || "build failed");
  if (result.outputs.length !== 1 || result.outputs[0]?.kind !== "entry-point") {
    fail("build must emit exactly one entry-point artifact");
  }
  if (!result.metafile) fail("build metadata is unavailable");
  for (const [inputPath, input] of Object.entries(result.metafile.inputs)) {
    if (NATIVE_OR_ASSET_INPUT.test(inputPath)) fail(`unsupported input: ${inputPath}`);
    for (const imported of input.imports) {
      if (imported.external === true && !BUILTIN_IMPORT.test(imported.path)) {
        fail(`runtime import is not self-contained: ${imported.path}`);
      }
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!BUILTIN_IMPORT.test(imported.path)) {
        fail(`emitted runtime import is not self-contained: ${imported.path}`);
      }
    }
  }
  return result.outputs[0];
}

function isPluginModule(value: unknown): value is JazzPluginModule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const module = value as Record<string, unknown>;
  return (
    module["apiVersion"] === 1 &&
    typeof module["register"] === "function" &&
    (module["dispose"] === undefined || typeof module["dispose"] === "function")
  );
}

async function atomicWrite(filePath: string, bytes: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o644, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Build one source plugin into a self-contained, installable release directory. */
export async function packPlugin(options: PackPluginOptions): Promise<PackedPlugin> {
  const pluginDirectory = path.resolve(options.pluginDirectory);
  const directory = await fs.lstat(pluginDirectory).catch(() => undefined);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    fail("pluginDirectory must be a real directory, not a symlink");
  }
  const source = await readSourceManifest(pluginDirectory);
  const entrypoint = resolveInside(pluginDirectory, source.entry ?? "src/index.ts");
  const entry = await fs.lstat(entrypoint).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink())
    fail("entry must be a regular file, not a symlink");
  const releaseDirectory = path.resolve(
    options.releaseDirectory ?? path.join(pluginDirectory, "release"),
  );
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    packages: "bundle",
    external: [],
    allowUnresolved: [],
    splitting: false,
    metafile: true,
    minify: false,
    sourcemap: "none",
    naming: "plugin.mjs",
  });
  const output = inspectBuild(result);
  const bytes = new Uint8Array(await output.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactPath = path.join(releaseDirectory, "plugin.mjs");
  await atomicWrite(artifactPath, bytes);
  try {
    const imported = (await import(
      `${pathToFileURL(artifactPath).href}?pack-validation=${Date.now()}`
    )) as { readonly default?: unknown };
    if (!isPluginModule(imported.default)) fail("default export does not implement plugin API v1");
  } catch (error) {
    await fs.rm(artifactPath, { force: true });
    throw error;
  }
  const digestPath = path.join(releaseDirectory, "plugin.mjs.sha256");
  await atomicWrite(digestPath, `${sha256}  plugin.mjs\n`);
  const catalogEntryPath = path.join(releaseDirectory, "catalog-entry.json");
  const { entry: _entry, ...metadata } = source;
  const manifest = parsePluginManifest({
    ...metadata,
    schemaVersion: metadata.schemaVersion ?? 1,
    artifact: "./plugin.mjs",
    sha256,
  });
  await atomicWrite(catalogEntryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactPath, digestPath, catalogEntryPath, sha256 };
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Create a minimal plugin source project without installing dependencies. */
export async function scaffoldPlugin(options: ScaffoldPluginOptions): Promise<string> {
  const directory = path.resolve(options.directory);
  const slug = path.basename(directory).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) {
    fail("target directory name must be a 3-64 character lowercase slug");
  }
  const id = options.pluginId ?? `com.example.${slug.replaceAll("-", ".")}`;
  const name = options.displayName ?? titleFromSlug(slug);
  // Validate author-controlled identity before creating anything.
  parsePluginManifest({
    schemaVersion: 1,
    id,
    name,
    version: "0.1.0",
    hostApi: 1,
    artifact: "./plugin.mjs",
    sha256: "0".repeat(64),
    hooks: ["route.skills"],
    decisionProviders: [],
    network: { destinations: [] },
    dataSent: [],
    secrets: [],
  });
  await fs.mkdir(directory, { recursive: false, mode: 0o755 });
  try {
    await fs.mkdir(path.join(directory, "src"));
    await fs.mkdir(path.join(directory, "tests"));
    await atomicWrite(
      path.join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: slug,
          version: "0.1.0",
          private: true,
          type: "module",
          packageManager: `bun@${SCAFFOLD_BUN_VERSION}`,
          scripts: { test: "bun test", pack: "jazz plugin pack ." },
          devDependencies: {
            "@jazz/plugin-sdk": SCAFFOLD_PLUGIN_SDK_VERSION,
            "bun-types": SCAFFOLD_BUN_TYPES_VERSION,
          },
        },
        null,
        2,
      )}\n`,
    );
    await atomicWrite(
      path.join(directory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            types: ["bun-types"],
          },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    await atomicWrite(
      path.join(directory, "jazz-plugin.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id,
          name,
          version: "0.1.0",
          hostApi: 1,
          entry: "src/index.ts",
          hooks: ["route.skills"],
          decisionProviders: [],
          network: { destinations: [] },
          dataSent: [],
          secrets: [],
        },
        null,
        2,
      )}\n`,
    );
    await atomicWrite(
      path.join(directory, "src/index.ts"),
      `import type { JazzPluginModule } from "@jazz/plugin-sdk";\n\nexport default {\n  apiVersion: 1,\n  register(api) {\n    api.hooks.register("route.skills", async (input) => ({\n      status: "answered",\n      distribution: {\n        skills: input.skills.map((skill) => ({ name: skill.name, probability: 0 })),\n        noSkillProbability: 1,\n      },\n    }));\n  },\n} satisfies JazzPluginModule;\n`,
    );
    await atomicWrite(
      path.join(directory, "tests/index.test.ts"),
      `import { expect, test } from "bun:test";\nimport plugin from "../src/index";\n\ntest("exports plugin API v1", () => {\n  expect(plugin.apiVersion).toBe(1);\n  expect(typeof plugin.register).toBe("function");\n});\n`,
    );
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertSameMembers(
  label: string,
  declared: readonly string[],
  registered: Set<string>,
): void {
  const expected = [...declared].sort();
  const actual = [...registered].sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    fail(
      `${label} registrations do not match manifest (declared: ${expected.join(", ") || "none"}; registered: ${actual.join(", ") || "none"})`,
    );
  }
}

function auditRegistration(manifest: PluginManifest, module: JazzPluginModule): PluginProbeResult {
  const hooks = new Set<string>();
  const providers = new Set<string>();
  const tools = new Set<string>();
  const commands = new Set<string>();
  const lifecycleEvents = new Set<string>();
  const declaredTools = new Set(manifest.tools.map((tool) => tool.name));
  const declaredCommands = new Set(manifest.commands.map((command) => command.name));
  const declaredLifecycle = new Set<string>(manifest.lifecycleHooks);
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: {
      register: (id) => {
        if (hooks.has(id)) fail(`hook ${id} was registered more than once`);
        hooks.add(id);
      },
    },
    decisions: {
      registerProvider: (provider) => {
        if (providers.has(provider.id))
          fail(`decision provider ${provider.id} was registered twice`);
        providers.add(provider.id);
        return {
          decide: (request, context) =>
            provider.decide(request, {
              signal: context?.signal ?? new AbortController().signal,
            }),
        };
      },
    },
    tools: {
      register: (registration) => {
        if (!declaredTools.has(registration.name))
          fail(`tool ${registration.name} is not declared in the manifest`);
        if (tools.has(registration.name))
          fail(`tool ${registration.name} was registered more than once`);
        tools.add(registration.name);
      },
    },
    commands: {
      register: (registration) => {
        if (!declaredCommands.has(registration.name))
          fail(`command ${registration.name} is not declared in the manifest`);
        if (commands.has(registration.name))
          fail(`command ${registration.name} was registered more than once`);
        commands.add(registration.name);
      },
    },
    lifecycle: {
      register: (registration) => {
        if (!declaredLifecycle.has(registration.event))
          fail(`lifecycle event ${registration.event} is not declared in the manifest`);
        lifecycleEvents.add(registration.event);
      },
    },
    secrets: { get: () => Promise.resolve(undefined) },
  };
  module.register(api);
  assertSameMembers("hook", manifest.hooks, hooks);
  assertSameMembers("decision provider", manifest.decisionProviders, providers);
  assertSameMembers("tool", [...declaredTools], tools);
  assertSameMembers("command", [...declaredCommands], commands);
  assertSameMembers("lifecycle event", [...declaredLifecycle], lifecycleEvents);
  return {
    manifest,
    registeredHooks: [...hooks].sort(),
    registeredDecisionProviders: [...providers].sort(),
    registeredTools: [...tools].sort(),
    registeredCommands: [...commands].sort(),
    registeredLifecycleEvents: [...lifecycleEvents].sort(),
  };
}

/** Verify and execute a packed plugin in a disposable store, without changing global state. */
export async function probePackedPlugin(
  options: ProbePackedPluginOptions,
): Promise<PluginProbeResult> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-probe-"));
  let module: JazzPluginModule | undefined;
  let closedBySession = false;
  try {
    const acquired = await acquirePluginManifest(path.resolve(options.manifestPath));
    const installer = new PluginArtifactInstaller({ pluginDirectory: temporary });
    const artifactPath = await installer.install(acquired.manifest, acquired.source);
    const namespace = (await import(`${pathToFileURL(artifactPath).href}?probe=${Date.now()}`)) as {
      readonly default?: unknown;
    };
    if (!isPluginModule(namespace.default)) fail("default export does not implement plugin API v1");
    module = namespace.default;
    const audit = auditRegistration(acquired.manifest, module);
    const session = await Effect.runPromise(
      createPluginSession({
        agentId: "plugin-probe",
        plugins: [{ manifest: acquired.manifest, module }],
        resolveSecret: () => Promise.resolve(undefined),
      }),
    );
    try {
      if (options.routeSkillsInput === undefined) return audit;
      if (!acquired.manifest.hooks.includes("route.skills")) {
        fail("route.skills input was provided but the hook is not declared");
      }
      const routeSkillsOutcome = await Effect.runPromise(
        session.runHook("route.skills", options.routeSkillsInput),
      );
      return { ...audit, routeSkillsOutcome };
    } finally {
      await Effect.runPromise(session.close());
      closedBySession = true;
    }
  } finally {
    if (module?.dispose && !closedBySession) {
      await Promise.resolve(module.dispose()).catch(() => undefined);
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Pack and probe a source plugin entirely in a disposable release directory. */
export async function devPlugin(options: DevPluginOptions): Promise<PluginProbeResult> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-dev-"));
  try {
    const packed = await packPlugin({
      pluginDirectory: options.pluginDirectory,
      releaseDirectory: temporary,
    });
    return await probePackedPlugin({
      manifestPath: packed.catalogEntryPath,
      ...(options.routeSkillsInput === undefined
        ? {}
        : { routeSkillsInput: options.routeSkillsInput }),
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

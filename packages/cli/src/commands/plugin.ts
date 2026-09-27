/**
 * Local-operator commands for Jazz's trusted in-process plugin lifecycle.
 *
 * These commands deliberately keep persistent code trust and egress consent on an
 * interactive local terminal. Installation and inspection never import plugin code.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ALL_AGENTS,
  PluginRegistryServiceImpl,
  devPlugin,
  isLocalSourceDirectory,
  packPlugin,
  parseGitHubPluginSource,
  probePackedPlugin,
  scaffoldPlugin,
  type PluginInspection,
} from "@jazz/adapters/plugins";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { CommandRiskInput, CompactToolsInput, SkillRouteInput } from "@jazz/core/types/plugin";
import { toError } from "@jazz/core/utils/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";

export interface PluginCommandOptions {
  readonly json?: boolean;
}

function registry(): PluginRegistryServiceImpl {
  return new PluginRegistryServiceImpl({
    pluginDirectory: path.join(getJazzHomeDirectory(), "plugins"),
  });
}

/** Resolve a catalog id while leaving explicit files and URLs untouched. */
function resolvePluginSource(source: string): string {
  if (source.includes("/") || source.includes("\\") || /^[a-z]+:/i.test(source)) return source;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) {
    throw new Error("Plugin source must be a manifest path, HTTPS URL, or valid catalog id.");
  }
  const configured = process.env["JAZZ_PLUGIN_CATALOG_URL"];
  const base = configured?.trim() || "https://jazz-cli.vercel.app/library/plugins/";
  return new URL(
    `${encodeURIComponent(source)}.json`,
    base.endsWith("/") ? base : `${base}/`,
  ).toString();
}

function attempt<T>(operation: () => Promise<T>): Effect.Effect<T, Error> {
  return Effect.tryPromise({
    try: operation,
    catch: toError,
  });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readSkillRouteInput(filePath: string): Promise<SkillRouteInput> {
  const value = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("Hook input must be a JSON object.");
  }
  const record = value;
  if (typeof record["requestText"] !== "string" || !Array.isArray(record["skills"])) {
    throw new Error("route.skills input requires requestText and a skills array.");
  }
  const skills = record["skills"].map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`skills[${index}] must be an object.`);
    }
    const skill = item;
    if (typeof skill["name"] !== "string" || typeof skill["description"] !== "string") {
      throw new Error(`skills[${index}] requires string name and description fields.`);
    }
    return { name: skill["name"], description: skill["description"] };
  });
  return { requestText: record["requestText"], skills };
}

async function readCommandRiskInput(filePath: string): Promise<CommandRiskInput> {
  const value = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("Hook input must be a JSON object.");
  }
  const record = value;
  if (Object.keys(record).length !== 1 || typeof record["command"] !== "string") {
    throw new Error("classify.command-risk input requires exactly one string command field.");
  }
  return { command: record["command"] };
}

async function readCompactToolsInput(filePath: string): Promise<CompactToolsInput> {
  const value = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("Hook input must be a JSON object.");
  }
  const record = value;
  if (typeof record["goal"] !== "string" || !Array.isArray(record["candidates"])) {
    throw new Error("compact.tools input requires a goal string and a candidates array.");
  }
  return value as unknown as CompactToolsInput;
}

/** Scaffold a types-only SDK plugin project; dependency installation remains explicit. */
export function pluginInitCommand(
  directory: string,
  options: { readonly id?: string; readonly name?: string } = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const created = yield* attempt(() =>
      scaffoldPlugin({
        directory,
        ...(options.id === undefined ? {} : { pluginId: options.id }),
        ...(options.name === undefined ? {} : { displayName: options.name }),
      }),
    );
    yield* terminal.success(`Created plugin project at ${created}.`);
    yield* terminal.info("Run 'bun install', then 'bun test' and 'jazz plugin dev .'.");
  });
}

/** Build and audit a plugin in a disposable host without changing installed state. */
export function pluginDevCommand(
  directory: string,
  options: { readonly hook?: string; readonly input?: string } = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (
      options.hook !== undefined &&
      options.hook !== "route.skills" &&
      options.hook !== "classify.command-risk" &&
      options.hook !== "compact.tools"
    ) {
      return yield* Effect.fail(new Error(`Unsupported v1 hook: ${options.hook}`));
    }
    if (options.input !== undefined && options.hook === undefined) {
      return yield* Effect.fail(new Error("--input requires --hook."));
    }
    yield* terminal.warn(
      "Development plugins execute inside Jazz with your full OS-user authority.",
    );
    const routeSkillsInput =
      options.input === undefined || options.hook !== "route.skills"
        ? undefined
        : yield* attempt(() => readSkillRouteInput(options.input!));
    const commandRiskInput =
      options.input === undefined || options.hook !== "classify.command-risk"
        ? undefined
        : yield* attempt(() => readCommandRiskInput(options.input!));
    const compactToolsInput =
      options.input === undefined || options.hook !== "compact.tools"
        ? undefined
        : yield* attempt(() => readCompactToolsInput(options.input!));
    const result = yield* attempt(() =>
      devPlugin({
        pluginDirectory: directory,
        ...(routeSkillsInput === undefined ? {} : { routeSkillsInput }),
        ...(commandRiskInput === undefined ? {} : { commandRiskInput }),
        ...(compactToolsInput === undefined ? {} : { compactToolsInput }),
      }),
    );
    printJson({ ok: true, result });
  });
}

/** Produce the exact self-contained artifact, digest, and install manifest. */
export function pluginPackCommand(directory: string): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const result = yield* attempt(() => packPlugin({ pluginDirectory: directory }));
    yield* terminal.success(`Packed ${result.artifactPath}.`);
    yield* terminal.log(`SHA-256: ${result.sha256}`);
    yield* terminal.log(`Install manifest: ${result.catalogEntryPath}`);
  });
}

/** Hidden standalone-binary probe used by the distribution integration test. */
export function pluginProbeArtifactCommand(
  manifestPath: string,
  inputPath?: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const routeSkillsInput =
      inputPath === undefined ? undefined : yield* attempt(() => readSkillRouteInput(inputPath));
    const result = yield* attempt(() =>
      probePackedPlugin({
        manifestPath,
        ...(routeSkillsInput === undefined ? {} : { routeSkillsInput }),
      }),
    );
    printJson({ ok: true, result });
  });
}

function formatEnabledAgents(agentIds: readonly string[]): string {
  if (agentIds.includes(ALL_AGENTS)) {
    return "all";
  }
  return agentIds.join(", ") || "none";
}

function manifestSummary(inspection: PluginInspection): readonly string[] {
  const { manifest } = inspection.current;
  return [
    `${manifest.name} (${manifest.id}) v${manifest.version}`,
    `code: ${manifest.sha256}`,
    `advisory hooks: ${manifest.hooks.join(", ") || "none"}`,
    `policy hooks: ${manifest.policyHooks.join(", ") || "none"}`,
    `decision providers: ${manifest.decisionProviders.join(", ") || "none"}`,
    `network: ${manifest.network.destinations.join(", ") || "none declared"}`,
    `data sent: ${manifest.dataSent.join("; ") || "none declared"}`,
    `trusted: ${inspection.trusted ? "yes" : "no"}`,
    `consented: ${inspection.consented ? "yes" : "no"}`,
    `enabled agents: ${formatEnabledAgents(inspection.enabledAgentIds)}`,
    `artifact valid: ${inspection.artifactValid ? "yes" : "no"}`,
    ...(inspection.restartRequired ? ["restart required to unload previously imported code"] : []),
  ];
}

function renderInspection(
  terminal: TerminalService,
  inspection: PluginInspection,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* terminal.heading("Jazz plugin");
    for (const line of manifestSummary(inspection)) yield* terminal.log(line);
  });
}

function requireInteractive(
  terminal: TerminalService,
  operation: string,
): Effect.Effect<void, Error> {
  return terminal.isInteractive
    ? Effect.void
    : Effect.fail(
        new Error(
          `${operation} requires a local interactive terminal; persistent plugin trust and consent cannot be granted headlessly.`,
        ),
      );
}

export function pluginAddCommand(
  source: string,
  options: PluginCommandOptions = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const github = parseGitHubPluginSource(source);
    const localSource = github ? false : yield* attempt(() => isLocalSourceDirectory(source));
    if (github) yield* terminal.info(`Fetching ${github.owner}/${github.repo} from GitHub…`);
    const result = yield* github
      ? attempt(() => registry().addFromSource({ github }))
      : localSource
        ? attempt(() => registry().addFromSource({ localDirectory: path.resolve(source) }))
        : attempt(() => registry().add(resolvePluginSource(source)));
    if (options.json === true) return printJson({ ok: true, result });
    yield* terminal.success(`Installed ${result.pluginId} at ${result.digest}.`);
    yield* terminal.info("It is not trusted or enabled. Inspect it before granting either.");
  });
}

export function pluginListCommand(
  options: PluginCommandOptions = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const plugins = yield* attempt(() => registry().list());
    if (options.json === true) return printJson({ ok: true, plugins });
    if (plugins.length === 0) return yield* terminal.info("No plugins installed.");
    yield* terminal.heading(`Plugins (${plugins.length})`);
    for (const plugin of plugins) {
      yield* terminal.log(
        `${plugin.id}  ${plugin.current.manifest.version}  ${plugin.trusted ? "trusted" : "untrusted"}  agents: ${plugin.enabledForAllAgents ? "all" : formatEnabledAgents(plugin.enabledAgentIds)}`,
      );
    }
  });
}

export function pluginInspectCommand(
  id: string,
  options: PluginCommandOptions = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const inspection = yield* attempt(() => registry().inspect(id));
    if (options.json === true) return printJson({ ok: true, plugin: inspection });
    yield* renderInspection(terminal, inspection);
  });
}

export function pluginTrustCommand(
  id: string,
  options: { yes?: boolean } = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (!options.yes) {
      yield* requireInteractive(terminal, "Plugin trust");
    }
    const service = registry();
    const inspection = yield* attempt(() => service.inspect(id));
    yield* renderInspection(terminal, inspection);
    if (!options.yes) {
      const confirmed = yield* terminal.confirm(
        `Are you sure you want to trust ${inspection.id}? This can execute code on your behalf.`,
        false,
      );
      if (!confirmed) {
        return yield* Effect.fail(new Error("Plugin trust cancelled."));
      }
    }
    yield* attempt(() => service.trust(inspection.id, inspection.current.manifest.sha256));
    yield* terminal.success(`Trusted ${inspection.id} at the inspected code digest.`);
  });
}

export function pluginEnableCommand(
  id: string,
  agentId?: string,
  options: { yes?: boolean } = {},
): Effect.Effect<void, Error, TerminalService | AgentService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const agent = agentId === undefined ? undefined : yield* getAgentByIdentifier(agentId);
    if (!options.yes) {
      yield* requireInteractive(terminal, "Plugin egress consent");
    }
    const service = registry();
    const inspection = yield* attempt(() => service.inspect(id));
    if (!inspection.trusted) {
      return yield* Effect.fail(
        new Error(
          `${inspection.id} is not trusted. Run 'jazz plugin trust ${inspection.id}' first.`,
        ),
      );
    }
    yield* renderInspection(terminal, inspection);
    if (inspection.current.manifest.policyHooks.length > 0) {
      yield* terminal.warn(
        "This plugin declares policy hooks that can affect authorization decisions, including whether Jazz asks before running a command.",
      );
    }
    if (!options.yes) {
      const target = agent === undefined ? "all agents" : agent.name;
      const confirmed = yield* terminal.confirm(
        `Enable ${inspection.id} for ${target}? It runs with your OS-user authority and its declared network and data access.`,
        false,
      );
      if (!confirmed) {
        return yield* Effect.fail(new Error("Plugin enablement cancelled."));
      }
    }
    yield* attempt(() => service.grantConsent(inspection.id, inspection.consentDigest));
    yield* attempt(() => service.enable(inspection.id, agent?.id));
    yield* terminal.success(
      agent === undefined
        ? `Enabled ${inspection.id} for all agents.`
        : `Enabled ${inspection.id} for agent ${agent.name} (${agent.id}).`,
    );

    // A required secret the host cannot already resolve would leave the plugin failing open on
    // every run, so provision it as part of setup instead of making the operator discover the gap
    // the first time the plugin silently abstains.
    for (const declaration of inspection.current.manifest.secrets) {
      if (!declaration.required) continue;
      const status = inspection.secrets.find((secret) => secret.name === declaration.name);
      if (status !== undefined && status.source !== "missing" && status.source !== "unavailable") {
        continue;
      }
      if (status?.source === "unavailable") {
        yield* terminal.warn(
          `No secure secret storage is available for ${declaration.name}. Set the ${
            declaration.env ?? "declared"
          } environment variable before running this agent.`,
        );
        continue;
      }
      yield* terminal.info(
        `${id} requires a secret: ${declaration.name}${
          declaration.description ? ` — ${declaration.description}` : ""
        }.`,
      );
      const secretValue = yield* terminal.ask(`Secret ${declaration.name}:`, {
        secret: true,
        simple: true,
        cancellable: true,
      });
      if (secretValue === undefined || secretValue.length === 0) {
        yield* terminal.warn(
          `Skipped ${declaration.name}. ${id} falls back to deterministic behavior until you run 'jazz plugin secret set ${id} ${declaration.name}'.`,
        );
        continue;
      }
      const stored = yield* attempt(() => service.setSecret(id, declaration.name, secretValue));
      yield* stored
        ? terminal.success(`Stored ${declaration.name} for ${id}.`)
        : terminal.warn(`Could not store ${declaration.name}: no secure storage available.`);
    }
  });
}

export function pluginDisableCommand(
  id: string,
  agentId?: string,
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const result = yield* attempt(() => registry().disable(id, agentId));
    yield* terminal.success(
      agentId === undefined ? `Disabled ${id} for every agent.` : `Disabled ${id} for ${agentId}.`,
    );
    if (result.restartRequired) {
      yield* terminal.warn("Restart long-lived Jazz processes to unload previously imported code.");
    }
  });
}

export function pluginUpdateCommand(
  id: string,
  source?: string,
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const service = registry();
    const inspection = yield* attempt(() => service.inspect(id));
    const result = yield* attempt(() => service.update(id, source ?? inspection.current.source));
    if (result.action === "already-current") {
      yield* terminal.success(`${id} is already up to date.`);
    } else {
      yield* terminal.success(
        `Updated ${id} to ${result.digest}; it is disabled pending trust and consent.`,
      );
    }
  });
}

export function pluginRollbackCommand(id: string): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const result = yield* attempt(() => registry().rollback(id));
    yield* terminal.success(
      `Rolled ${id} back to ${result.digest}; it is disabled pending grants.`,
    );
  });
}

export function pluginRemoveCommand(
  id: string,
  options: { readonly keepSecrets?: boolean } = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (terminal.isInteractive && !(yield* terminal.confirm(`Remove plugin ${id}?`, false))) return;
    if (!terminal.isInteractive) {
      return yield* Effect.fail(new Error("Plugin removal requires a local interactive terminal."));
    }
    const result = yield* attempt(() => registry().remove(id, options));
    yield* terminal.success(`Removed ${id}.`);
    if (result.restartRequired) {
      yield* terminal.warn("Restart long-lived Jazz processes to unload previously imported code.");
    }
  });
}

export function pluginDoctorCommand(
  id: string,
  options: PluginCommandOptions = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const report = yield* attempt(() => registry().doctor(id));
    if (options.json === true) return printJson({ ok: report.healthy, report });
    yield* renderInspection(terminal, report);
    if (report.healthy) return yield* terminal.success("Plugin checks passed.");
    for (const problem of report.problems) yield* terminal.error(problem);
  });
}

export function pluginGcCommand(): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const removed = yield* attempt(() => registry().gc());
    yield* terminal.success(`Removed ${removed.length} unreferenced plugin artifact(s).`);
  });
}

export function pluginSecretSetCommand(
  id: string,
  name: string,
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* requireInteractive(terminal, "Plugin secret storage");
    const value = yield* terminal.ask(`Secret ${name}:`, { secret: true, simple: true });
    if (value === undefined || value.length === 0) {
      return yield* Effect.fail(new Error("Secret entry cancelled."));
    }
    const stored = yield* attempt(() => registry().setSecret(id, name, value));
    if (!stored)
      return yield* Effect.fail(new Error("No secure plugin secret storage is available."));
    yield* terminal.success(`Stored secret ${name} for ${id}.`);
  });
}

export function pluginSecretForgetCommand(
  id: string,
  name: string,
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* attempt(() => registry().deleteSecret(id, name));
    yield* terminal.success(`Forgot Jazz-owned secret ${name} for ${id}.`);
  });
}

export function pluginSecretStatusCommand(
  id: string,
  name: string,
  options: PluginCommandOptions = {},
): Effect.Effect<void, Error, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const inspection = yield* attempt(() => registry().inspect(id));
    const status = inspection.secrets.find((secret) => secret.name === name);
    if (status === undefined)
      return yield* Effect.fail(new Error(`${id} did not declare secret ${name}.`));
    if (options.json === true) return printJson({ ok: true, status });
    yield* terminal.log(`${id}/${name}: ${status.source}`);
  });
}

/**
 * Turning installed plugins on and off: the trust and consent prompts `jazz plugin trust` and
 * `jazz plugin enable` ask, and the `/plugins` checklist that toggles plugins for the open
 * conversation or for good. Both paths share these prompts so a plugin is never enabled with less
 * consent from one than from the other.
 */

import * as path from "node:path";
import {
  PluginRegistryServiceImpl,
  hookConflicts,
  type PluginInspection,
} from "@jazz/adapters/plugins";
import type { PluginRuntimeService } from "@jazz/core/interfaces/plugin-runtime";
import {
  report,
  type ChoicePreviewLine,
  type PromptChoice,
  type PromptTagTone,
  type ReportRow,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import { toError } from "@jazz/core/utils/errors";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";

export function openPluginRegistry(): PluginRegistryServiceImpl {
  return new PluginRegistryServiceImpl({
    pluginDirectory: path.join(getJazzHomeDirectory(), "plugins"),
  });
}

function attempt<T>(operation: () => Promise<T>): Effect.Effect<T, Error> {
  return Effect.tryPromise({ try: operation, catch: toError });
}

export function requireInteractive(
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

/** Ask to trust the plugin's current code digest. `yes` is itself the consent. */
export function confirmPluginTrust(
  terminal: TerminalService,
  inspection: PluginInspection,
  options: { readonly yes?: boolean } = {},
): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    if (options.yes === true) {
      return true;
    }
    yield* requireInteractive(terminal, "Plugin trust");
    const confirmed = yield* terminal.confirm(
      `Are you sure you want to trust ${inspection.id}? This can execute code on your behalf.`,
      false,
    );
    return confirmed === true;
  });
}

/**
 * Ask to let the plugin run for `target` with its declared network and data access, warning first
 * when it can affect authorization decisions. `yes` is itself the consent.
 */
export function confirmPluginEnable(
  terminal: TerminalService,
  inspection: PluginInspection,
  target: string,
  options: { readonly yes?: boolean } = {},
): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    if (inspection.current.manifest.policyHooks.length > 0) {
      yield* terminal.warn(
        "This plugin declares policy hooks that can affect authorization decisions, including whether Jazz asks before running a command.",
      );
    }
    if (options.yes === true) {
      return true;
    }
    yield* requireInteractive(terminal, "Plugin egress consent");
    const confirmed = yield* terminal.confirm(
      `Enable ${inspection.id} for ${target}? It runs with your OS-user authority and its declared network and data access.`,
      false,
    );
    return confirmed === true;
  });
}

/**
 * Ask for each required secret the host cannot already resolve. Without one the plugin abstains on
 * every run, so setup provisions it instead of leaving the gap to be discovered later.
 */
export function provisionPluginSecrets(
  terminal: TerminalService,
  service: PluginRegistryServiceImpl,
  inspection: PluginInspection,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const id = inspection.id;
    for (const declaration of inspection.current.manifest.secrets) {
      if (!declaration.required) {
        continue;
      }
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
          declaration.description ? ` (${declaration.description})` : ""
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

/** Where a `/plugins` change applies: the open conversation only, or the saved state for every agent. */
export type PluginScope = "conversation" | "always";

/** Whether the plugin runs for `agentId` now: its conversation override, else its saved enablement. */
export function pluginActiveFor(
  inspection: PluginInspection,
  agentId: string,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  return (
    overrides.get(inspection.id) ??
    (inspection.enabledForAllAgents || inspection.enabledAgentIds.includes(agentId))
  );
}

/** The short state shown flush right of a plugin in the checklist. */
export function pluginStateTag(
  inspection: PluginInspection,
  agentId: string,
  overrides: ReadonlyMap<string, boolean>,
): { readonly tag: string; readonly tone: PromptTagTone } {
  const override = overrides.get(inspection.id);
  if (override !== undefined) {
    return override
      ? { tag: "on · temporary", tone: "accent" }
      : { tag: "off · temporary", tone: "warning" };
  }
  if (inspection.enabledForAllAgents) {
    return { tag: "on", tone: "success" };
  }
  if (inspection.enabledAgentIds.includes(agentId)) {
    return { tag: "on for this agent", tone: "success" };
  }
  if (inspection.enabledAgentIds.length > 0) {
    const count = inspection.enabledAgentIds.length;
    return {
      tag: `on for ${String(count)} other ${count === 1 ? "agent" : "agents"}`,
      tone: "muted",
    };
  }
  return inspection.trusted ? { tag: "off", tone: "muted" } : { tag: "untrusted", tone: "muted" };
}

function listOrNone(values: readonly string[], none = "none"): string {
  return values.length === 0 ? none : values.join(", ");
}

/** What a person needs to decide on a plugin: what it hooks, contributes, reaches, and is granted. */
export function pluginDetails(inspection: PluginInspection): { label: string; text: string }[] {
  const { manifest } = inspection.current;
  const details: { label: string; text: string }[] = [
    { label: "version", text: `${manifest.version} (${manifest.id})` },
  ];
  const contributes = [
    ...manifest.tools.map((tool) => `tool ${tool.name}`),
    ...manifest.commands.map((command) => `/${command.name}`),
    ...manifest.skills.map((skill) => `skill ${skill.name}`),
    ...manifest.personas.map((persona) => `persona ${persona.name}`),
  ];
  if (contributes.length > 0) {
    details.push({ label: "adds", text: contributes.join(", ") });
  }
  if (manifest.hooks.length > 0 || manifest.policyHooks.length > 0) {
    details.push({ label: "hooks", text: [...manifest.hooks, ...manifest.policyHooks].join(", ") });
  }
  if (manifest.lifecycleHooks.length > 0) {
    details.push({ label: "observes", text: manifest.lifecycleHooks.join(", ") });
  }
  details.push(
    { label: "network", text: listOrNone(manifest.network.destinations, "none declared") },
    { label: "data sent", text: listOrNone(manifest.dataSent, "none declared") },
    {
      label: "granted",
      text: [
        inspection.trusted ? "code trusted" : "code not trusted",
        inspection.consented ? "access consented" : "access not consented",
      ].join(", "),
    },
  );
  if (manifest.policyHooks.length > 0) {
    details.push({
      label: "caution",
      text: "its policy hooks can change whether Jazz asks before running a command",
    });
  }
  return details;
}

export function pluginChoices(
  inspections: readonly PluginInspection[],
  agentId: string,
  overrides: ReadonlyMap<string, boolean>,
): PromptChoice<string>[] {
  return inspections.map((inspection) => {
    const state = pluginStateTag(inspection, agentId, overrides);
    const preview: ChoicePreviewLine[] = pluginDetails(inspection).map((detail) => [
      { text: `${detail.label}: ${detail.text}` },
    ]);
    return {
      name: inspection.current.manifest.name,
      value: inspection.id,
      tag: state.tag,
      tagTone: state.tone,
      preview,
    };
  });
}

export interface PluginChange {
  readonly inspection: PluginInspection;
  readonly enable: boolean;
}

/** The plugins whose checked state differs from whether they run now; turning off comes first. */
export function pluginChanges(
  inspections: readonly PluginInspection[],
  checkedIds: ReadonlySet<string>,
  agentId: string,
  overrides: ReadonlyMap<string, boolean>,
): PluginChange[] {
  const changes = inspections
    .filter(
      (inspection) =>
        checkedIds.has(inspection.id) !== pluginActiveFor(inspection, agentId, overrides),
    )
    .map((inspection) => ({ inspection, enable: checkedIds.has(inspection.id) }));
  return [
    ...changes.filter((change) => !change.enable),
    ...changes.filter((change) => change.enable),
  ];
}

export interface PluginChangeOutcome {
  /** `id: what it is now`, for each change that took effect. */
  readonly applied: readonly { readonly id: string; readonly state: string }[];
  /** Changes left undone because a trust or consent prompt was declined. */
  readonly declined: readonly string[];
  readonly failed: readonly string[];
  /** A plugin turned off had already loaded code into this process, which cannot unload it. */
  readonly restartRequired: boolean;
}

function scopeLabel(scope: PluginScope, enable: boolean): string {
  if (scope === "conversation") {
    return enable ? "on for this conversation" : "off for this conversation";
  }
  return enable ? "on for every agent" : "off for every agent";
}

function applyOneChange(
  terminal: TerminalService,
  service: PluginRegistryServiceImpl,
  runtime: PluginRuntimeService,
  change: PluginChange,
  scope: PluginScope,
  agentId: string,
): Effect.Effect<"applied" | "declined" | { readonly restartRequired: boolean }, Error> {
  return Effect.gen(function* () {
    const id = change.inspection.id;
    if (!change.enable) {
      if (scope === "conversation") {
        yield* runtime.setConversationOverride(id, false, agentId);
      } else {
        yield* attempt(() => service.disable(id));
        yield* runtime.clearConversationOverrides(id);
      }
      return {
        restartRequired: yield* runtime.hasLoadedDigest(change.inspection.current.manifest.sha256),
      };
    }

    let inspection = yield* attempt(() => service.inspect(id));
    if (!inspection.trusted) {
      if (!(yield* confirmPluginTrust(terminal, inspection))) {
        return "declined";
      }
      yield* attempt(() => service.trust(id, inspection.current.manifest.sha256));
    }
    if (!inspection.consented) {
      const target = scope === "conversation" ? "this conversation" : "all agents";
      if (!(yield* confirmPluginEnable(terminal, inspection, target))) {
        return "declined";
      }
      yield* attempt(() => service.grantConsent(id, inspection.consentDigest));
    }

    if (scope === "conversation") {
      yield* runtime.setConversationOverride(id, true, agentId);
    } else {
      // The saved enable checks the saved state; a plugin turned on for this conversation only is
      // just as active, and a second handler for its hook would stop every run from starting.
      const overrides = yield* runtime.listConversationOverrides();
      const activeHere = (yield* attempt(() => service.list())).filter(
        (other) => other.id !== id && pluginActiveFor(other, agentId, overrides),
      );
      const conflicts = hookConflicts(
        inspection.current.manifest,
        activeHere.map((other) => other.current.manifest),
      );
      if (conflicts.length > 0) {
        return yield* Effect.fail(new Error(`Plugin hook conflict: ${conflicts.join("; ")}`));
      }
      yield* attempt(() => service.enable(id));
      yield* runtime.clearConversationOverrides(id);
    }

    inspection = yield* attempt(() => service.inspect(id));
    yield* provisionPluginSecrets(terminal, service, inspection);
    return "applied";
  });
}

/** Apply every change at one scope; one plugin's failure or declined prompt never stops the rest. */
export function applyPluginChanges(
  terminal: TerminalService,
  service: PluginRegistryServiceImpl,
  runtime: PluginRuntimeService,
  changes: readonly PluginChange[],
  scope: PluginScope,
  agentId: string,
): Effect.Effect<PluginChangeOutcome> {
  return Effect.gen(function* () {
    const applied: { id: string; state: string }[] = [];
    const declined: string[] = [];
    const failed: string[] = [];
    let restartRequired = false;
    for (const change of changes) {
      const id = change.inspection.id;
      const outcome = yield* applyOneChange(
        terminal,
        service,
        runtime,
        change,
        scope,
        agentId,
      ).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        failed.push(`${id}: ${toError(outcome.failure).message}`);
      } else if (outcome.success === "declined") {
        declined.push(id);
      } else {
        if (typeof outcome.success === "object" && outcome.success.restartRequired) {
          restartRequired = true;
        }
        applied.push({ id, state: scopeLabel(scope, change.enable) });
      }
    }
    return { applied, declined, failed, restartRequired };
  });
}

/** "Turn on Example tool, turn off Router": the pending changes, by display name. */
function describeChanges(changes: readonly PluginChange[]): string {
  const names = (enable: boolean) =>
    changes
      .filter((change) => change.enable === enable)
      .map((change) => change.inspection.current.manifest.name)
      .join(", ");
  const parts = [
    ...(changes.some((change) => change.enable) ? [`Turn on ${names(true)}`] : []),
    ...(changes.some((change) => !change.enable) ? [`turn off ${names(false)}`] : []),
  ];
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function pluginListRows(
  inspections: readonly PluginInspection[],
  agentId: string,
  overrides: ReadonlyMap<string, boolean>,
): ReportRow[] {
  return inspections.map((inspection) => ({
    kind: "item",
    name: inspection.id,
    detail: pluginStateTag(inspection, agentId, overrides).tag,
  }));
}

/**
 * `/plugins`: one checklist of installed plugins, checked when they run for this agent now, with
 * each one's hooks, access and grants beside it. Unchanged rows are left alone; for the rest, one
 * question picks whether the change holds for this conversation or is saved for every agent.
 * Returns whether any plugin changed state, so the caller can refresh what plugins contribute.
 */
export function managePlugins(
  terminal: TerminalService,
  runtime: PluginRuntimeService,
  agentId: string,
): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    const service = openPluginRegistry();
    const inspections = yield* attempt(() => service.list());
    if (inspections.length === 0) {
      yield* terminal.log(
        report("plugins", [
          { kind: "text", text: "No plugins installed." },
          { kind: "item", name: "jazz plugin add owner/repo", detail: "installs one from GitHub" },
        ]),
      );
      return false;
    }
    const overrides = yield* runtime.listConversationOverrides();
    if (!terminal.isInteractive) {
      yield* terminal.log(report("plugins", pluginListRows(inspections, agentId, overrides)));
      yield* terminal.log(
        "jazz plugin enable <id> turns one on; jazz plugin disable <id> turns it off.",
      );
      return false;
    }

    const checked = yield* terminal.checkbox<string>(
      "Check the plugins to run. Enter applies; Esc changes nothing.",
      {
        choices: pluginChoices(inspections, agentId, overrides),
        default: inspections
          .filter((inspection) => pluginActiveFor(inspection, agentId, overrides))
          .map((inspection) => inspection.id),
      },
    );
    if (checked === undefined) {
      return false;
    }
    const changes = pluginChanges(inspections, new Set(checked), agentId, overrides);
    if (changes.length === 0) {
      yield* terminal.log(report("plugins", [{ kind: "text", text: "Nothing changed." }]));
      return false;
    }

    const scope = yield* terminal.select<PluginScope>(
      `${describeChanges(changes)}. For how long?`,
      {
        choices: [
          {
            name: "This conversation",
            value: "conversation",
            description: "Until you leave this conversation; nothing is saved",
          },
          {
            name: "Always",
            value: "always",
            description: "Saved for every agent and every conversation",
          },
        ],
      },
    );
    if (scope === undefined) {
      yield* terminal.log(report("plugins", [{ kind: "text", text: "Nothing changed." }]));
      return false;
    }

    const outcome = yield* applyPluginChanges(terminal, service, runtime, changes, scope, agentId);
    const rows: ReportRow[] = [
      ...outcome.applied.map((entry): ReportRow => ({
        kind: "field",
        key: entry.id,
        value: entry.state,
      })),
      ...outcome.declined.map((id): ReportRow => ({
        kind: "field",
        key: id,
        value: "unchanged, not granted",
      })),
    ];
    if (rows.length > 0) {
      yield* terminal.log(report("plugins", rows));
    }
    for (const failure of outcome.failed) {
      yield* terminal.warn(`Not changed: ${failure}`);
    }
    if (outcome.restartRequired) {
      yield* terminal.warn("Restart Jazz to unload code a disabled plugin already loaded.");
    }
    return outcome.applied.length > 0;
  });
}

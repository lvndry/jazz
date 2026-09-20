---
description: "Install, inspect, trust, configure, enable, update, and remove optional Jazz plugins safely."
---

# Plugins

Jazz plugins are optional, pre-bundled JavaScript modules that extend the harness. A plugin may add
an advisory hook (`route.skills`, which suggests a skill before the first model request) and/or
contribute **model-callable tools** that appear in the agent's tool set. An advisory hook cannot
authorize a tool, change approval policy, or act on the model's behalf; a contributed tool is a
real tool and goes through the same approval and risk gating as any built-in.

Plugins are absent and disabled by default. A normal Jazz installation has no plugin network call,
latency, prompt change, or credential requirement.

## Trust means code execution

Plugins run inside the Jazz process with the authority of the operating-system user. The manifest's
hook, network, data, and secret declarations support review and consent; they are not a sandbox.
A plugin can technically read files or environment variables, access the network, block Jazz, or
terminate the process without using the host API.

For that reason installation, code trust, data-egress consent, and per-agent enablement are separate
steps. First-time trust and new consent can be granted only from a local interactive terminal.
Chat and unattended surfaces report the required local command instead.

```bash
jazz plugin add <catalog-plugin-id>
# Or install a locally packed/third-party manifest explicitly:
jazz plugin add ./release/catalog-entry.json
jazz plugin inspect com.example.router
jazz plugin trust com.example.router
jazz plugin enable com.example.router --agent default
```

`add` verifies and stores bytes but never imports them. Jazz imports a module lazily only for a run
whose agent has enabled it and whose exact code and consent digests are still granted.

Enabled `route.skills` plugins currently run in shadow mode: bounded usage, latency, and cost are
measured, but their answer does not change the provider request. Maintainers can explicitly test
host-rendered advisory injection with `JAZZ_EXPERIMENTAL_PLUGIN_ADVISORY=1`; this is not enabled by
installation, trust, or consent and remains gated on held end-to-end eval results.

## Tools

A plugin may contribute model-callable tools. Each tool is declared in the manifest — name,
description, a JSON Schema for its arguments, a `riskLevel` (`read-only` / `low-risk` /
`high-risk`), and whether calling it sends model-authored content off the machine (`egress`) — and
the module supplies the matching handler. The manifest declaration is the reviewed, consented
contract; the module can neither register an undeclared tool nor claim a lower risk than declared.

When a plugin is enabled for an agent, its tools join that agent's tool set automatically — no
separate mention in the agent's config is needed. Jazz namespaces each tool (`plugin_<id>_<tool>`)
so it never collides, advertises the declared JSON Schema to the model, and **validates the model's
arguments against that schema before the handler runs**. A `read-only` tool runs directly; anything
else becomes an approval-gated tool, so a person confirms it under the active approval policy exactly
like a built-in. A handler that throws, times out, or is unavailable returns an error result to the
model rather than crashing the run.

```jsonc
// jazz-plugin.json
{
  "tools": [
    {
      "name": "reverse_text",
      "description": "Reverse the characters of the given text.",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false,
      },
      "riskLevel": "read-only",
      "egress": false,
    },
  ],
}
```

```ts
// src/index.ts
import type { JazzPluginModule } from "@jazz/plugin-sdk";

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    api.tools.register({
      name: "reverse_text",
      handler: (args) =>
        Promise.resolve({ content: [...String(args["text"] ?? "")].reverse().join("") }),
    });
  },
};

export default plugin;
```

`plugins/example-tool` in the repository is a complete, minimal example.

## Lifecycle

```bash
jazz plugin list
jazz plugin doctor com.example.router
jazz plugin update com.example.router
jazz plugin rollback com.example.router
jazz plugin disable com.example.router --agent default
jazz plugin remove com.example.router
jazz plugin gc
```

An update keeps one previous artifact for rollback and returns the plugin to pending trust/consent
when code or declared data changes. Disablement prevents new dispatch after the state commit. Since
JavaScript modules are process-cached, a daemon or bot restart is required to remove already-loaded
code, timers, sockets, or global mutations completely.

Plugin state lives under `$JAZZ_HOME/plugins/` (normally `~/.jazz/plugins/`). Artifacts are stored by
SHA-256. State transitions are cross-process locked and atomically committed.

## Secrets

A plugin may ask only for secret names declared in its manifest. Resolution is environment first,
then Jazz-owned secure storage. Set or clear a stored value without putting it in shell history:

```bash
jazz plugin secret set com.example.router apiKey
jazz plugin secret status com.example.router apiKey
jazz plugin secret forget com.example.router apiKey
```

`remove` deletes Jazz-owned plugin secrets unless `--keep-secrets` is passed. It cannot delete an
environment variable and reports when one remains effective.

## Authoring

```bash
jazz plugin init my-router
cd my-router
bun install
# Commit the generated bun.lock before publishing.
bun test
jazz plugin dev . --hook route.skills --input fixtures/request.json
jazz plugin pack .
```

`pack` produces one self-contained `release/plugin.mjs`, its SHA-256 file, and a catalog entry. All
package dependencies must be bundled. Runtime imports, native addons, emitted assets, and install
scripts are unsupported. The module receives the plain-JavaScript API from `@jazz/plugin-sdk`; it
must not import Jazz internals.

The official catalog build runs reviewed, locked source without provider credentials and publishes
the generated manifest plus its immutable digest-addressed artifact with the Jazz website. Authors
never choose the catalog's authoritative digest.

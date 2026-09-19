---
description: "Install, inspect, trust, configure, enable, update, and remove optional Jazz plugins safely."
---

# Plugins

Jazz plugins are optional, pre-bundled JavaScript modules that add advisory harness behavior. They
are not model-selected tools. Version 1 exposes one hook, `route.skills`, which may suggest a skill
before the first model request. It cannot authorize a tool, change approval policy, or execute an
action on the model's behalf.

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

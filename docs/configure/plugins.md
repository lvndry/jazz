---
description: "Install, inspect, trust, configure, enable, update, and remove optional Jazz plugins safely."
---

# Plugins

Jazz plugins are optional, pre-bundled JavaScript modules that add bounded harness behavior. They
are not model-selected tools and cannot execute an action on the model's behalf. Version 1 exposes
an advisory hook, `route.skills`, and a policy hook, `classify.command-risk`. The distinction is
important: routing only suggests context, while command-risk classification can affect whether the
active approval policy requires a person to approve one shell command.

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

An enabled `route.skills` plugin ranks the live skills for the turn, and Jazz adds a short,
non-authoritative relevance hint for the top skill to the first provider request when it beats the
no-skill option. The hint is transient provider context: it never enters durable history, resume
state, work state, or telemetry, and the plugin can never load a skill, change tools, or authorize
anything. Any error or abstention falls back to deterministic behavior, and routing is skipped for
resumes and summarizer runs.

## Command-risk policy hook

`classify.command-risk` is eligible only for `execute_command`, whose declared risk is `unknown`
because its arguments determine what it can do. The plugin classifies the proposed command as
`read-only`, `low-risk`, or `high-risk`; Jazz validates that result and applies the operator's
approval policy. A lower classification can therefore remove an approval prompt. Enabling this hook
is explicit consent to that effect.

The plugin is not the enforcement point. It cannot lower another tool's declared risk, expand the
run's effective tool set, override a command allowlist, change the selected approval tier, or bypass
the shell denylist. Jazz sends the hook only the bounded command string: not conversation history,
tool results, environment variables, or file contents. Network-backed manifests must disclose that
command-text egress and its exact destination before local consent can be granted.

If the hook is absent, abstains, times out, fails validation, exceeds its budget, or becomes
unavailable, Jazz falls back to its built-in command classifier. If classification remains
unresolved, the command is treated as `high-risk`. Plugin failure never silently makes an unknown
command safer.

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
then Jazz-owned secure storage. `jazz plugin enable` prompts for any required secret it cannot
already resolve and stores it in secure storage, so first-time setup needs no manual export or
separate command. Set or clear a stored value later without putting it in shell history:

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
jazz plugin dev . --hook classify.command-risk --input fixtures/command.json
jazz plugin pack .
```

The command-risk fixture is a JSON object such as `{ "command": "git status" }`. Development
probing resolves declared environment-backed secrets from the current shell, while keeping the
plugin disposable and out of installed state.

`pack` produces one self-contained `release/plugin.mjs`, its SHA-256 file, and a catalog entry. All
package dependencies must be bundled. Runtime imports, native addons, emitted assets, and install
scripts are unsupported. The module receives the plain-JavaScript API from `@jazz/plugin-sdk`; it
must not import Jazz internals.

The official catalog build runs reviewed, locked source without provider credentials and publishes
the generated manifest plus its immutable digest-addressed artifact with the Jazz website. Authors
never choose the catalog's authoritative digest.

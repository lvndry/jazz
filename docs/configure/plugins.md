---
description: "Install, inspect, trust, configure, enable, update, and remove optional Jazz plugins safely."
---

# Plugins

Jazz plugins are optional, pre-bundled JavaScript modules that extend the harness. A plugin may
contribute any mix of capabilities:

- **tools** — model-callable functions that join the agent's tool set;
- **commands** — user-invoked `/name` slash commands;
- **personas** — selectable agent personalities;
- **skills** — loadable instruction documents;
- an advisory **hook** (`route.skills`) that suggests a skill before the first model request.

Tools and commands run code and are gated accordingly; personas and skills are inert declared data.
An advisory hook cannot authorize a tool, change approval policy, or act on the model's behalf.

Plugins are absent and disabled by default. A normal Jazz installation has no plugin network call,
latency, prompt change, or credential requirement. Everything a plugin adds is declared in its
manifest — the reviewed, consented contract — and the module can never exceed what it declared.

## Trust means code execution

Plugins run inside the Jazz process with the authority of the operating-system user. The manifest's
hook, network, data, and secret declarations support review and consent; they are not a sandbox.
A plugin can technically read files or environment variables, access the network, block Jazz, or
terminate the process without using the host API.

For that reason installation, code trust, data-egress consent, and per-agent enablement are separate
steps. First-time trust and new consent can be granted only from a local interactive terminal.
Chat and unattended surfaces report the required local command instead.

```bash
# GitHub is the default source: no author build, pack, or release step.
jazz plugin add owner/repo            # latest default branch
jazz plugin add owner/repo@v1.2.3     # pin a branch, tag, or commit
jazz plugin inspect com.example.router
jazz plugin trust com.example.router
jazz plugin enable com.example.router --agent default
```

`jazz plugin add owner/repo` downloads the repository tarball over HTTPS — no local `git` — extracts
it, and hashes the source tree; that hash is the digest you trust. A local directory holding a
`jazz-plugin.json` installs the same way (`jazz plugin add ./my-plugin`). A curated catalog id, an
HTTPS manifest URL, or a locally packed `./release/catalog-entry.json` still install as bundled
artifacts (see [Authoring](#authoring)).

`add` stores the source or bytes but never imports them. Jazz imports a module lazily only for a run
whose agent has enabled it and whose exact code and consent digests are still granted; before each
run it re-hashes the installed source tree and refuses to load code that no longer matches its
trusted digest.

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

`plugins/example-tool` in the repository is a complete, minimal example — it contributes one of
each capability below.

## Commands

A plugin may contribute user-invoked slash commands. Each is declared in the manifest (name +
description); the module registers a handler via `api.commands.register`. When a plugin is enabled,
its commands are registered at chat startup and behave like the built-in dynamic commands: `/name`
autocompletes (with a `(plugin)` badge), and running it invokes the handler, whose returned
`message` becomes your next turn to the agent. Built-in, skill, and MCP-prompt commands win a name
collision, so a plugin cannot shadow `/help`. A command that returns nothing is a quiet no-op.

## Personas

A plugin may contribute personas — pure manifest data (name, description, systemPrompt, optional
tone/style), no handler or egress. An enabled plugin's personas appear alongside built-in and
custom ones in the wizard, `/switch`, and `jazz persona list`, and an agent's `config.persona` may
name one. A built-in or custom persona of the same name always wins.

## Skills

A plugin may contribute skills — inert instruction documents declared in the manifest (name,
description, content). They appear in the skill index the model sees; the body is injected only
when the model loads the skill, never automatically. A skill of the same name from any other source
takes precedence. A plugin skill is instruction-trust surface (it can steer the model), not a
capability grant — it cannot itself act or reach the network.

## Lifecycle hooks

A plugin may subscribe to host lifecycle events, declared in the manifest (`lifecycleHooks`) and
registered via `api.lifecycle.register`. Handlers are **fire-and-forget observers**: they receive a
bounded payload (agent id, conversation id, the run's working directory `cwd`, and event-specific
`data`) and **cannot change what the host does** — a throw or timeout is swallowed and never delays
or breaks the run. To _influence_ a decision (routing, tool-result pruning, command risk) a plugin
uses an advisory or policy hook instead, not a lifecycle event.

| Event                | Fires when                  | `data`                                       |
| -------------------- | --------------------------- | -------------------------------------------- |
| `session-start`      | A chat session starts       | —                                            |
| `session-end`        | A chat session ends         | —                                            |
| `user-prompt`        | You submit a prompt         | `prompt`                                     |
| `run-complete`       | A turn finishes             | `prompt`, `summary`                          |
| `run-failed`         | A turn errors               | `error`                                      |
| `awaiting-input`     | Jazz is waiting for you     | —                                            |
| `tool-start`         | A tool call begins          | `tool`, `toolCallId`                         |
| `tool-end`           | A tool call succeeds        | `toolCallId`, `durationMs`, `summary?`       |
| `tool-error`         | A tool call fails           | `toolCallId`, `durationMs`, `error`          |
| `permission-request` | A tool needs approval       | `tool`, `toolCallId`, `riskLevel?`           |
| `permission-denied`  | An approval is declined     | `tool`, `toolCallId`, `auto`                 |
| `subagent-start`     | A sub-agent is spawned      | `agentName?`, `task?`                        |
| `subagent-stop`      | A sub-agent finishes        | `agentName?`, `durationMs?`                  |
| `compact-start`      | History compaction begins   | `messages`, `tokensBefore`                   |
| `compact-end`        | History compaction finishes | `messagesBefore/After`, `tokensBefore/After` |

`data` fields are bounded (long strings truncated) and may be absent, so always guard
(`event.data?.summary`). The tool, permission, and sub-agent events are delivered on the interactive
streaming path.

The handler's second argument is a context with an `AbortSignal` and **`writeTerminalSequence`** —
use the latter to send a terminal escape sequence (for example an OSC notification) to the user's
terminal. The host writes to the controlling terminal directly, so the sequence reaches it **even
though Jazz's fullscreen UI owns stdout** — plugin authors don't have to know that detail.

This is what a terminal-notification plugin rides. A Warp notifier subscribes to `run-complete`
(task finished) and `awaiting-input` (Jazz is waiting on you) and emits an OSC sequence bound to the
terminal tab — the same shape as
[`warpdotdev/claude-code-warp`](https://github.com/warpdotdev/claude-code-warp). Off a supporting
terminal a plugin can instead shell out to a desktop notifier.

```ts
api.lifecycle.register({
  event: "run-complete",
  handler: async (event, { writeTerminalSequence }) => {
    const summary = typeof event.data?.summary === "string" ? event.data.summary : "done";
    // OSC 777 desktop notification, delivered to the user's terminal (e.g. a Warp tab).
    writeTerminalSequence(`\u001b]777;notify;Jazz;${summary}\u0007`);
  },
});
```

## Global vs per-agent

Tools attach to the agent whose run registers them. Personas and skills are treated as globally
available once a plugin is enabled anywhere — there is no separate per-agent gating for inert data.

## Lifecycle

```bash
jazz plugin list
jazz plugin doctor com.example.router
jazz plugin update owner/repo        # re-fetches a source install; omit the source to reuse the recorded one
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
bun test
jazz plugin dev . --hook route.skills --input fixtures/request.json
git init && git add -A && git commit -m "my plugin" && git push   # publish
```

To publish, push the repository to GitHub — no build, pack, digest, or release step. Users install
it with `jazz plugin add owner/repo`, and Jazz imports the entry (`src/index.ts`) directly. Keep the
plugin dependency-free: it should import only Node/Bun built-ins and the plain-JavaScript API from
`@jazz/plugin-sdk`, and must not import Jazz internals. `node_modules` and `.git` are excluded from
the trusted source-tree hash.

For a plugin that genuinely needs bundled dependencies, `jazz plugin pack .` still produces a
self-contained `release/plugin.mjs`, its SHA-256, and a catalog entry, installable as a bundled
artifact from a local path or HTTPS manifest URL — an opt-in escape hatch, no longer the default.

The official catalog build runs reviewed, locked source without provider credentials and publishes
the generated manifest plus its immutable digest-addressed artifact with the Jazz website. Authors
never choose the catalog's authoritative digest.

The official catalog build runs reviewed, locked source without provider credentials and publishes
the generated manifest plus its immutable digest-addressed artifact with the Jazz website. Authors
never choose the catalog's authoritative digest.

---
description: "Install, inspect, trust, configure, enable, update, and remove optional Jazz plugins safely."
---

# Plugins

Jazz plugins are optional, pre-bundled JavaScript modules that extend the harness. A plugin may
contribute any mix of capabilities:

- **tools** — model-callable functions that join the agent's tool set;
- **workspace context** — bounded, current context supplied before a model request as the agent
  reads or changes files;
- **commands** — user-invoked `/name` slash commands;
- **personas** — selectable agent personalities;
- **skills** — loadable instruction documents;
- **advisory hooks** — `route.skills` (suggest a skill before the first model request),
  `compact.tools` (choose which stale tool results to prune during compaction), `classify.page`
  (flag a browser page for extra scrutiny), and `route.snapshot` (put the relevant elements of a
  browser snapshot first), which only shape context or add scrutiny;
- a **policy hook** — `classify.command-risk`, which can affect whether the active approval policy
  requires a person to approve one shell command.

Tools and commands run code and are gated accordingly; personas and skills are inert declared data.
Advisory hooks cannot authorize a tool, change approval policy, or act on the model's behalf; the
policy hook shapes approval only.

## Install a plugin for one agent

Browse the [Marketplace](https://jazz-cli.vercel.app/library) for reviewed plugins. For example,
the [LSP plugin](./lsp-plugin.md) adds code navigation and compiler diagnostics:

```bash
jazz plugin add com.jazz.plugins.lsp
jazz plugin inspect com.jazz.plugins.lsp
jazz plugin trust com.jazz.plugins.lsp
jazz plugin enable com.jazz.plugins.lsp --agent <agent-name>
```

Review the code, declared capabilities, network destinations, and secrets before trusting.
Omit `--agent` only when you want the plugin enabled for every agent, including future agents.
Plugins are disabled until you trust and enable them.

## Trust means code execution

Plugins run inside the Jazz process with the authority of the operating-system user. The manifest's
hook, network, data, and secret declarations support review and consent; they are not a sandbox.
A plugin can technically read files or environment variables, access the network, block Jazz, or
terminate the process without using the host API.

For that reason installation, code trust, data-egress consent, and per-agent enablement are separate
steps. First-time trust and new consent can be granted only from a local interactive terminal.
`--yes` skips the confirmation question but not that requirement: `jazz plugin trust` and
`jazz plugin enable` refuse to run from a script, a pipe, or CI. Chat and unattended surfaces report
the required local command instead.

```bash
# GitHub is the default source: no author build, pack, or release step.
jazz plugin add owner/repo            # latest default branch
jazz plugin add owner/repo@v1.2.3     # pin a branch, tag, or commit
jazz plugin inspect com.example.router
jazz plugin trust com.example.router
jazz plugin enable com.example.router --agent default
# Or enable for every agent, including agents created later:
jazz plugin enable com.example.router
```

If a lifecycle command names a plugin that is not installed, Jazz shows an installation command,
for example `jazz plugin add com.jazz.plugins.lsp`. Install it first, then inspect, trust, and enable
it; the error does not install or enable anything automatically.

`jazz plugin add owner/repo` downloads the repository tarball over HTTPS (no local `git`),
extracts it, and hashes the source tree; that hash is the digest you trust. A local directory
holding a `jazz-plugin.json` installs the same way (`jazz plugin add ./my-plugin`). A curated
catalog id, an HTTPS manifest URL, or a locally packed `./release/catalog-entry.json` still install
as bundled artifacts (see [Authoring](#authoring)).

### What the digest pins

The digest is only worth trusting if it covers every byte the plugin can load, so `add` refuses a
source that could run code the digest does not cover:

- The manifest `entry` must be a plain relative path inside the plugin (no `..`, no absolute path),
  and it must be a regular file.
- The tree may hold only regular files and directories. A symlink, hard link, device, or FIFO
  anywhere in the tree (or in the GitHub tarball) fails the install. `node_modules` and `.git` are
  skipped by name and are not part of the digest.
- Jazz reads every import, re-export, `require`, and literal dynamic import reachable from the
  entry without running any of it. Each must be a Node or Bun built-in or a file inside the plugin.
  Imports that reach outside the plugin (`../`, an absolute path, a tsconfig alias pointing out) are
  refused, and so are package imports, because packages resolve from `node_modules`, which the
  digest does not cover.
- A bundled artifact may import only Node or Bun built-ins.

The GitHub download stays on `api.github.com` and `codeload.github.com` over HTTPS, times out
after 60 seconds, and is capped at 32 MB compressed and 128 MB extracted.

## Community plugin discovery

Public repositories can opt into Jazz's metadata-only community directory by adding the exact
GitHub topic `jazz-plugin` and a valid root `jazz-plugin.json`. Jazz's scheduled index refresh reads
repository metadata, resolves the default branch to a full commit SHA, and fetches only that JSON
manifest. It never checks out, builds, imports, or executes community repository code.

Community entries are labeled **community-indexed — not reviewed by Jazz**. Their declared hooks,
network destinations, data classes, secrets, tools, and commands are disclosures supplied by the
repository, not independent security findings. Jazz shows the observed commit and emits an install
command pinned to it:

```bash
jazz plugin add owner/repo@<commit-sha>
```

The normal local lifecycle still applies: installation stores and hashes the source, then the
operator must inspect, trust, grant egress consent, and enable it. Community entries are kept out
of the reviewed artifact catalog and cannot be installed by reviewed catalog id.

`add` stores the source or bytes but never imports them. Jazz imports a module lazily only for a run
whose agent has enabled it — per agent, or for all agents — and whose exact code and consent digests
are still granted. Before each run it repeats every install check on the installed copy (entry,
hash, file types, and import graph) and refuses to load code that no longer matches its trusted
digest, including a file swapped for a symlink after you trusted it.

An enabled `route.skills` plugin ranks the live skills for the turn, and Jazz adds a short,
non-authoritative relevance hint for the top skill to the first provider request when it beats the
no-skill option. The hint is transient provider context: it never enters durable history, resume
state, work state, or telemetry, and the plugin can never load a skill, change tools, or authorize
anything. Any error or abstention falls back to deterministic behavior, and routing is skipped for
resumes and summarizer runs.

## Tool-compaction hook

`compact.tools` runs before summarization: automatically at the clear rung of the context ladder —
once a run passes 50% of its context window, and on every iteration above it — and as a lossless
pre-pass when you invoke `/compact` yourself (which otherwise jumps straight to the summarizer).
Below 50% nothing is touched. For each old, large tool result it decides keep / truncate / drop;
Jazz applies the decision by replacing content (never removing a message, so assistant/tool pairing
stays valid) and only ever sends the result preview, not the whole body. The policy is asymmetric —
a result is dropped only on a confident signal, a large uncertain one is truncated to head and tail,
and anything else is kept.
If the plugin abstains, times out, or is absent, Jazz falls back to its deterministic tool-result
clearer. It never touches user or assistant text.

Because this happens quietly mid-run, Jazz surfaces it: the first time a run reclaims space this way
it prints a one-line green notice crediting the plugin, and the individual keep / truncate / drop
decisions are written to the log (`Compaction plugin tool-result decisions`) at both the clear rung
and `/compact`. `/compact` additionally shows the decisions live and names the plugin as it works.

## Browser page hooks

Two advisory hooks serve the [browser tools](../concepts/browser.md).

`classify.page` runs on each `browser_snapshot`. It receives the page's origin (scheme and host,
never the path or query), its title, up to 200 interactive elements as role and label pairs, and
whether the page has a password or payment card field. It returns a probability for each of four
flags: `credential-entry`, `payment`, `captcha`, and `agent-directed-instructions`. A flag at or
above 0.5 adds scrutiny: `browser_act` asks on every call on that page, even under the `high-risk`
policy or an allowlist, and the approval and the snapshot carry a warning that Jazz words from the
flag names alone. Jazz rebuilds the answer from those two fields, so nothing else a plugin returns
can reach a decision, and no answer can lower a risk, skip an approval, remove a flag the page's own
structure raised, or clear the untrusted-content marking.

`route.snapshot` runs on the first window of a snapshot. It receives your latest request, the
origin, and the same elements, and returns a probability for each element plus one for none. Up to
eight elements at or above 0.1 are listed first under "Likely relevant to your request:". The whole
outline follows unchanged, so a wrong answer costs attention and hides nothing.

Neither hook receives page text. Both time out after two seconds like the other advisory hooks,
and any error, invalid answer, or abstention leaves the snapshot exactly as it would be without
them. `jazz plugin dev` cannot run these two hooks yet.

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

## Tools

For a complete optional tool plugin, see the [generic LSP plugin](./lsp-plugin.md), which
connects configured language servers to semantic code navigation and approved refactors.

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

Tool handlers receive the agent's current working directory and an abort signal. A mutating tool
may register both `prepare` and `executePrepared`: `prepare` returns an approval message, optional
diff, and JSON-serializable prepared data. Jazz persists that data with the approval, including
parked runs. Only the hidden execution tool receives it, after approval. The plugin must revalidate
any files or remote state that could have changed while approval was pending. Without those
callbacks, Jazz shows a bounded argument preview and runs the ordinary handler after approval.

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
when code or declared data changes. An update also disables the plugin everywhere, including a
`jazz plugin enable` grant for all agents, so the new code runs only after you enable it again. Disablement prevents new dispatch after the state commit. Since
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

The [Plugin SDK README](../../packages/plugin-sdk/README.md) has a complete minimal plugin,
development setup, and an overview of the public TypeScript contracts and host API.

```bash
jazz plugin init my-router
cd my-router
bun install
bun test
jazz plugin dev . --hook route.skills --input fixtures/request.json
jazz plugin dev . --hook classify.command-risk --input fixtures/command.json
git init && git add -A && git commit -m "my plugin" && git push   # publish
```

The command-risk fixture is a JSON object such as `{ "command": "git status" }`. Development
probing resolves declared environment-backed secrets from the current shell, while keeping the
plugin disposable and out of installed state.

To publish, push the repository to GitHub. There is no build, pack, digest, or release step.
Users install it with `jazz plugin add owner/repo`, and Jazz imports the entry (`src/index.ts`)
directly. Keep the plugin dependency-free: it may import Node/Bun built-ins and its own files, and
it imports `@jazz/plugin-sdk` with `import type` only (the SDK is types, so nothing is left to load
at runtime). Write `apiVersion: 1` rather than importing the constant. Install refuses any other
import; see [What the digest pins](#what-the-digest-pins).

For a plugin that genuinely needs bundled dependencies, `jazz plugin pack .` still produces a
self-contained `release/plugin.mjs`, its SHA-256, and a catalog entry, installable as a bundled
artifact from a local path or HTTPS manifest URL — an opt-in escape hatch, no longer the default.

The official catalog build runs reviewed, locked source without provider credentials and publishes
the generated manifest plus its immutable digest-addressed artifact with the Jazz website. Authors
never choose the catalog's authoritative digest.

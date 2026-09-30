# `@jazz/plugin-sdk`

The public TypeScript contract for writing Jazz plugins. It has no runtime dependencies:
plugins use plain JavaScript values, promises and `AbortSignal`, while Jazz supplies the
host API when it loads them. You do not need Jazz internals or Effect to write a plugin.

Import SDK declarations with **`import type`**. Write `apiVersion: 1` in your module rather
than importing `PLUGIN_API_VERSION` at runtime. Source-installed plugins may import only
their own files and Node/Bun built-ins at runtime; SDK type imports are erased.

## Development setup

In this repository, plugin packages use `"@jazz/plugin-sdk": "workspace:*"` as a
development dependency. For a plugin outside the workspace, install the SDK from a
local Jazz checkout:

```sh
mkdir my-plugin
cd my-plugin
bun init -y
bun add --dev /absolute/path/to/jazz/packages/plugin-sdk
```

The SDK is only needed during development. A local dependency gives your editor and
TypeScript the contracts without adding a runtime dependency to the plugin.

## A complete plugin

Create these files inside `my-plugin`:

```text
my-plugin/
├── jazz-plugin.json
└── src/index.ts
```

The manifest declares the capabilities the operator reviews before enabling the plugin.
This example contributes one offline, read-only tool:

```json
{
  "schemaVersion": 1,
  "id": "com.example.echo",
  "name": "Echo",
  "version": "0.1.0",
  "hostApi": 1,
  "entry": "src/index.ts",
  "hooks": [],
  "policyHooks": [],
  "decisionProviders": [],
  "tools": [
    {
      "name": "echo_text",
      "description": "Return the supplied text unchanged.",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false
      },
      "riskLevel": "read-only",
      "egress": false
    }
  ],
  "network": { "destinations": [] },
  "dataSent": [],
  "secrets": []
}
```

In `src/index.ts`, default-export a module satisfying `JazzPluginModule`:

```ts
import type { JazzPluginModule } from "@jazz/plugin-sdk";

export default {
  apiVersion: 1,
  register(api) {
    api.tools.register({
      name: "echo_text",
      handler: async (args) => {
        const text = args["text"];
        if (typeof text !== "string") {
          return { content: "Expected a string in text.", isError: true };
        }
        return { content: text };
      },
    });
  },
} satisfies JazzPluginModule;
```

`register` must be synchronous: Jazz seals registrations when it returns. Handlers are
asynchronous and receive an abort signal; tool handlers also receive the agent's current
working directory. Jazz validates tool arguments against the manifest's JSON Schema
before calling the handler. `dispose`, if supplied, runs during session cleanup and may
return a promise.

From the directory containing `my-plugin`, install and enable it in a local interactive
terminal. Replace `default` with your agent's name or ID:

```sh
jazz plugin add ./my-plugin
jazz plugin inspect com.example.echo
jazz plugin trust com.example.echo
jazz plugin enable com.example.echo --agent default
```

Installation stores and verifies code without executing it. Trust and enablement are
separate decisions. Once enabled, Jazz adds the namespaced tool to that agent's tool set.
Publish the source repository on GitHub and users can install it with
`jazz plugin add owner/repo`; dependency-free source plugins need no build step. Plugins
with runtime package dependencies must use [bundled distribution](../../docs/configure/plugins.md#authoring).

## Host API

The [SDK declarations](./src/index.ts) are the full API reference. Every capability must
be declared in `jazz-plugin.json` before its matching handler can register.

| API                              | Purpose                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `api.tools.register`             | Add a model-callable tool with its declared schema, risk and egress behavior.                                                          |
| `api.commands.register`          | Add a slash command; its returned `message` becomes a user turn for the agent.                                                         |
| `api.hooks.register`             | Advise skill routing (`route.skills`), tool-result compaction (`compact.tools`), or browser pages (`classify.page`, `route.snapshot`). |
| `api.policy.register`            | Classify shell-command risk (`classify.command-risk`), which can affect approval.                                                      |
| `api.decisions.registerProvider` | Register a decision provider and receive a host-managed decision client.                                                               |
| `api.lifecycle.register`         | Observe declared lifecycle events, such as `run-complete` or `awaiting-input`.                                                         |
| `api.workspace.register`         | Supply bounded, transient workspace context before model requests.                                                                     |
| `api.secrets.get`                | Resolve a secret name declared by the plugin, from environment or secure storage.                                                      |

Personas and skills are manifest-only contributions; they need no runtime registration.
Use `JazzPluginSourceManifest` to type-check a manifest authored in TypeScript.

For mutating tools, declare an honest `low-risk` or `high-risk` tier. Optional `prepare`
and `executePrepared` callbacks separate a side-effect-free proposal from execution:
Jazz persists the proposal with approval, and the execution callback must revalidate
state that could have changed while approval was pending. See the [tool contract](../../docs/configure/plugins.md#tools).

Plugins run in-process with the permissions of the OS user. Manifest declarations enable
review, validation and consent; they are not a sandbox. Honor cancellation signals,
disclose network destinations and data sent, and never log secrets.

## Further reading

- [Plugin guide](../../docs/configure/plugins.md): installation, consent, secrets, updates and authoring.
- [Example plugin](../../plugins/example-tool): tools, commands, personas, skills and lifecycle events.
- [LSP plugin](../../plugins/lsp): workspace context and approved refactors.
- [Plugin lifecycle](../../docs/maintainers/plugin-lifecycle.md): loading, integrity and host boundaries.

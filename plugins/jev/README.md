# Jev decision provider

Jev is an optional Jazz plugin that uses TypeSafe's System One API for small,
structured decisions inside the agent harness. It complements your agent's main
model and currently pins `jev-1.13.0`.

## What it does

| Capability                                            | How Jazz uses it                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill routing (`route.skills`)                        | Ranks installed skills against your current request. Jazz can suggest the most relevant skill to the main model; the plugin does not load it itself.                                                            |
| Tool-result compaction (`compact.tools`)              | Recommends keeping, truncating, or dropping old tool-result content during context cleanup. Dropping requires a confident signal; uncertain large results are truncated. User and assistant text are untouched. |
| Command-risk classification (`classify.command-risk`) | Classifies proposed `execute_command` calls as read-only, low-risk, or high-risk before Jazz applies your approval policy.                                                                                      |

The plugin adds no model-callable tools. Errors, timeouts, invalid answers, and
abstentions fall back to Jazz's built-in behavior. For command risk, Jazz falls
back to its built-in classifier and treats unresolved classification as high-risk.

## Enable it

You need Jazz with plugin support and a TypeSafe API key. Run these commands in
your local terminal:

```bash
jazz plugin add com.jazz.plugins.jev
jazz plugin inspect com.jazz.plugins.jev
jazz plugin trust com.jazz.plugins.jev
jazz plugin enable com.jazz.plugins.jev --agent default
```

Replace `default` with your agent's name or ID. To enable Jev for every agent,
including agents created later, omit `--agent`:

```bash
jazz plugin enable com.jazz.plugins.jev
```

`enable` asks for the required `apiKey` when it is missing and stores it in Jazz's
secure storage. Alternatively, provide `TYPESAFE_API_KEY` in the environment of
the Jazz process; it takes precedence over the stored key. If secure storage is
unavailable, use that environment variable.

To set or replace the stored key later, use the interactive secret prompt:

```bash
jazz plugin secret set com.jazz.plugins.jev apiKey
jazz plugin secret status com.jazz.plugins.jev apiKey
jazz plugin doctor com.jazz.plugins.jev
```

For a local checkout, replace the `add` command above with this command from the
Jazz repository root, then follow the same inspect, trust, and enable steps:

```bash
jazz plugin add ./plugins/jev
```

## Data and approvals

Jev sends decision inputs to `https://api.typesafe.ai/v1/systemone`: the current
request and installed skill names/descriptions for routing; proposed shell command
text for risk classification; and the goal plus bounded tool-call metadata,
inputs, and result previews for compaction. These are external API calls using
your TypeSafe account.

Plugins execute inside Jazz with your OS-user authority; they are not sandboxed.
Inspect the declarations before trusting and enabling the plugin. Command-risk
classification can remove an approval prompt when a command's classification is
covered by your active approval policy. Jazz still enforces its tool permissions,
command allowlists, and shell denylist.

## Disable it

```bash
# Disable for one agent:
jazz plugin disable com.jazz.plugins.jev --agent default

# Disable for all agents:
jazz plugin disable com.jazz.plugins.jev
```

Restart long-running Jazz processes, such as bots or daemons, to fully unload
already-imported plugin code.

See the [plugin guide](../../docs/configure/plugins.md) for updates, removal,
secrets, and the full trust lifecycle, or the [implementation](src/index.ts) and
[manifest](jazz-plugin.json) for the exact decision rules and declarations.

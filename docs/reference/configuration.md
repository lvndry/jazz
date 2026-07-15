# Configuration Reference

Jazz is configured via configuration files and environment variables.

## Configuration File Locations

Jazz loads configuration from two layers:

1. **`~/.jazz/config.json`** — Global config (agents, API keys, defaults). All writes go here.
2. **`./.jazz/config.json`** — Optional project-local overrides (like `.claude/`). Read-only merge on top of global.

Merge order: defaults → `~/.jazz/config.json` → `./.jazz/config.json`.

Agents and storage always live in the Jazz home directory (`~/.jazz` or `JAZZ_HOME`), even when project overrides exist.

You can replace the global config path with `$JAZZ_CONFIG_PATH` or `--config`. Project-local `./.jazz/config.json` still merges on top.

Legacy `./jazz.config.json` in the project root is no longer discovered automatically. Move settings to `~/.jazz/config.json`.

## MCP Servers: `.agents/mcp.json`

Jazz also loads MCP servers from the `.agents` convention paths. These are merged with the main config (project overrides user):

- `~/.agents/mcp.json` — User-level MCP config
- `./.agents/mcp.json` — Project-level MCP config

See [MCP Servers](../integrations/index.md#mcp-servers) for format details.

## Main Config: `~/.jazz/config.json`

```json
{
  "defaultModel": "anthropic:claude-3-5-sonnet",
  "theme": "dark",
  "notifications": true,
  "autoUpdate": true,
  "logLevel": "info"
}
```

## Project Overrides: `./.jazz/config.json`

Use for project-specific settings such as MCP enable/disable flags or logging level. Do not put agent storage paths here — agents always load from `~/.jazz`.

## Environment Variables

You can override settings or provide API keys via `.env` or system environment variables.

- `OPENAI_API_KEY`: Key for OpenAI models.
- `ANTHROPIC_API_KEY`: Key for Anthropic models.
- `JAZZ_HOME`: Override the Jazz home directory (default: `~/.jazz`). Use when developing Jazz to isolate test data.
- `JAZZ_CONFIG_PATH`: Override the global config file path.
- `DEBUG`: Set to `true` for verbose logging.

## Agent Config: `customTools`

`customTools` is an optional field on an agent's `config`, letting a deployment declare new
tools directly in the agent's JSON config instead of shipping code — the closest analog is the
Claude Agent SDK's custom tools (name, description, input schema, handler, registered alongside
builtins). Declaring a custom tool is not enough to expose it: its `name` must also appear in
the agent's `tools` array, exactly like a builtin or MCP tool. A declared-but-unlisted custom
tool is simply skipped at registration.

Each entry has a `handler.type` of either `record` or `command`.

**`record`** — no side effect. The call is validated and appended to the run's `toolCalls` (the
same field every other tool call surfaces in), so the *caller* embedding Jazz can read the
arguments and act on them; the model itself only ever sees the fixed `response`. This is the
pattern behind confirmation-card / propose-then-confirm flows:

```json
{
  "name": "propose_action",
  "description": "Propose an action for the user to confirm before it is carried out.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "description": "Short description of the proposed action" },
      "payload": { "type": "object", "description": "Structured data needed to carry out the action" }
    },
    "required": ["action"]
  },
  "handler": {
    "type": "record",
    "response": "Proposal recorded — the user will see a confirmation card."
  }
}
```

**`command`** — spawns `handler.command` directly (an argv array, no shell) with the validated
tool arguments serialized as JSON on the child's stdin. Exit code `0` returns stdout (capped at
16 KB) as the tool result; a non-zero exit, spawn error, or timeout produces a failure result the
model sees the same way it sees a failing builtin tool. The command's environment is sanitized
the same way `execute_command` sanitizes its shell environment (see `envAllowlist` below), using
the `envAllowlist` of the agent that DECLARED the tool, not whichever agent happens to be calling
it. **Security note:** command tools execute with no interactive approval step — they are always
registered `high-risk` and run whatever the deployment configured the moment the model calls
them, so treat `handler.command` entries as deployment-authored, trusted commands, not
user-supplied ones.

```json
{
  "name": "lint_project",
  "description": "Run the project linter",
  "parameters": {
    "type": "object",
    "properties": {}
  },
  "handler": {
    "type": "command",
    "command": ["./lint.sh"],
    "timeoutMs": 30000
  }
}
```

`timeoutMs` defaults to 30 000 ms and is capped at 300 000 ms (5 minutes) when set.

### Validation rules

- `name`: must match `^[a-z][a-z0-9_]{1,63}$`, must be unique within `customTools`, and must not
  start with the `mcp_` prefix (reserved for MCP-sourced tools).
- At most 16 entries per agent.
- `description`: 1-1024 characters — this is what the model reads to decide when to call the tool.
- `parameters`: a JSON Schema object; must have `"type": "object"`. Only a subset of JSON Schema
  is honored by the converter that turns this into the runtime validator: unsupported keywords
  are silently dropped, and a property with a missing or unrecognized `type` degrades to an
  empty object schema — which then rejects a scalar argument (string/number/boolean) passed for
  that property. Stick to `string`, `number`, `integer`, `boolean`, `null`, `enum`, and plain
  nested objects/arrays of those.
- `handler.response` (record): optional string, at most 1024 characters, defaults to `"Recorded."`.
- `handler.command` (command): a non-empty array of non-empty strings.

### Collisions and re-registration

A custom tool name that collides with an already-registered builtin or MCP tool name — or one of
its aliases (e.g. `glob`) — fails the run with a configuration error rather than silently
overriding the existing tool; rename the custom tool or remove the conflicting one. Because tool
registration runs on every agent run (not just once per process), re-registering the *exact
same* custom tool definition under a name that's already registered is a no-op, not a collision;
only a genuinely different definition sharing that name is rejected — and since the registry has
no way to update an existing registration in place, that rejection fails the run MID-SESSION
(not at process startup): restart the session, or revert the custom tool definition to match
what was registered earlier.

## Agent Config: `envAllowlist`

`envAllowlist` is an optional `string[]` field on an agent's `config` that exempts specific
environment variable names from the sensitive-name scrub applied to shell commands the agent
runs (`execute_command` and custom `command`-handler tools share this same env-sanitization
path; it does not affect `grep`/`find`/`git` tool spawns). By default, any variable whose name
matches `API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` (case-insensitive) is stripped before a
child process is spawned. Listing a name in `envAllowlist` copies that variable from the
process environment into the child's environment even though it matches the scrub regex — it
never invents a value that isn't already set. `SSH_*`-prefixed names and the small set of base
env vars Jazz always sets itself (`PATH`, `HOME`, `USER`, `SHELL`, etc.) can never be
allowlisted — that block applies unconditionally, regardless of `envAllowlist` membership.

```json
{
  "envAllowlist": ["MY_SERVICE_TOKEN"]
}
```

Validation: at most 32 names, each matching `^[A-Z][A-Z0-9_]{0,63}$` (uppercase letters,
digits, and underscores, starting with a letter, up to 64 characters).

**Security note:** allowlisting a secret-bearing variable hands it to every shell command the
agent runs — the deployment owns that trade-off.

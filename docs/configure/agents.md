---
description: "Configure Jazz agents: primary and companion models, personas, context limits, tool restrictions, custom tools, environment access, and memory scopes."
---

# Agent configuration

An agent is the durable identity Jazz runs on every surface. Its JSON selects the primary model,
persona, tools, memory, and optional specialist companions. Run budgets and output belong to the
application, workflow, or individual run—not the agent.

Agent files live under `$JAZZ_HOME/agents/`, normally `~/.jazz/agents/`. The easiest starting point
is `jazz agent create`; edit the generated file for fields the wizard does not expose.

## Complete shape

```json
{
  "id": "incident-briefing",
  "name": "incident-briefing",
  "description": "Correlates incident evidence and produces an executive visual briefing.",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-5.4-mini",
    "summarizerModel": "openai/gpt-5.4-mini",
    "reasoningEffort": "medium",
    "maxContextTokens": 64000,
    "temperature": 0.2,
    "deniedTools": ["execute_command"],
    "tools": ["publish_briefing"],
    "customTools": [
      {
        "name": "publish_briefing",
        "description": "Publish the approved incident briefing to the team's webhook.",
        "parameters": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "summary": { "type": "string" }
          },
          "required": ["title", "summary"]
        },
        "handler": {
          "type": "command",
          "command": [
            "curl",
            "--fail-with-body",
            "--request",
            "POST",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            "https://briefings.example.com/hooks/incidents"
          ],
          "timeoutMs": 30000
        }
      }
    ],
    "companions": {
      "analyze:image": "provider/vision-model",
      "analyze:audio": "provider/audio-model",
      "generate:image": "provider/image-generation-model"
    },
    "memoryScopes": ["incident-briefing"]
  }
}
```

Replace provider, model, and endpoint placeholders. Keep credentials out of agent files; use Jazz's
provider configuration, the system keyring, or narrowly allowlisted environment variables.

## Models and context

- `persona` names a built-in or installed persona. It defaults to `default` when Jazz creates an
  agent.
- `llmProvider` and `llmModel` select the primary reasoning and tool-use model.
- `summarizerModel` is a `provider/model` used for context compaction and command risk
  classification. If it is missing or invalid, Jazz uses the primary model.
- `reasoningEffort` accepts `disable`, `low`, `medium`, or `high`. Unsupported non-disabled values
  fail validation.
- `temperature` accepts `0` through `2`. Jazz omits it when unset; models that reject custom
  temperature ignore it.
- `numCtx` sets Ollama's `num_ctx` to a positive token count.
- `maxContextTokens` places a positive per-agent ceiling on the effective context window across
  providers. Jazz warns and compacts against that ceiling.
- `companions` binds specialist models independently for `analyze` and `generate` across `image`,
  `audio`, and `video`. See [Model companions](../features/media.md).

`llmApiKeys` can override provider keys inside an agent file, but plaintext credentials make the
file difficult to share safely. Prefer `jazz config`, environment variables, or the keyring.

## Tool access

`tools` adds named tools, MCP servers, or custom tools to the built-in bundle permitted by the
persona. It is **not an allowlist**. Omitting `execute_command` from `tools` does not remove shell
access.

Use `deniedTools` for a hard per-agent restriction. Jazz applies it after built-in, persona, MCP,
peer, and custom capabilities are assembled, so an earlier grant cannot add the tool back. Use
exact tool names from `jazz tools list` or the [tool inventory](../tools/index.md).

`webSearchProvider` selects the configured search backend. `envAllowlist` may exempt at most 32
uppercase environment-variable names from command secret scrubbing. Treat each exemption as a
credential grant to every command the agent can run.

## Custom tools

`customTools` exposes a narrow function to the model without writing a Jazz plugin. A definition is
registered only when its name also appears in `tools`.

- Names are 2–64 lowercase letters, digits, or underscores, start with a letter, and cannot start
  with `mcp_` or collide with another tool or alias.
- `description` is 1–1024 characters and should say when to call the tool.
- `parameters` is a JSON Schema object with `type: "object"`.
- A `record` handler returns fixed text and is read-only.
- A `command` handler spawns the argv directly—never through a shell—and writes validated arguments
  as JSON to stdin. It runs in the current working directory, uses Jazz's scrubbed environment,
  and is always high-risk. `timeoutMs` may be 1–300000.

For authenticated SaaS actions, prefer an MCP server whose schema, authentication, and errors are
explicit. A command-backed webhook is useful when the HTTP endpoint itself is the stable interface.

## Memory

`memoryScopes` controls which long-term memory namespaces the agent can read and write. The default
is the agent's own id. Share a scope between agents only when they should deliberately share durable
context; conversation history remains separate.

Run `jazz agent show <name>` to inspect the resolved agent and `/tools` inside chat to see the tools
available to that run.

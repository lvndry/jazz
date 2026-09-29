---
description: "Configure a Jazz agent for a specific job: model, provider, persona, skills, and tool policy, saved as one JSON file per agent."
---

# Creating agents

Create an agent with its own model, persona, tools, and skills.

```bash
jazz agent create
```

The wizard asks for a provider, model, reasoning level, persona, name, and tools.
For a first agent, choose the `default` persona; for repository work, choose `coder`.

After creating it, start a conversation:

```bash
jazz agent chat <agent-name>
```

To script agent creation, write the JSON file directly (shape below) or copy an existing one.

---

## What the wizard asks

| Choice               | Guidance                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider + model** | See [Providers](../configure/providers.md). `openrouter` with a free model costs nothing; `ollama` keeps everything local unless you pick a `:cloud` model, which needs an [Ollama API key](../configure/providers.md#ollama)          |
| **Reasoning**        | How much reasoning effort to request from a model that supports it. You can leave the default selected.                                                                                                                                |
| **Persona**          | `default`, `coder`, `researcher`, or one of yours. See [Personas](../concepts/personas.md)                                                                                                                                             |
| **Name**             | How you'll refer to it: `jazz agent chat reviewer`.                                                                                                                                                                                    |
| **Toolset**          | Extra capabilities to add, including configured MCP servers. Built-in tools are supplied by the persona's tool profile; use `deniedTools` in the agent file for hard per-agent restrictions. Selecting an MCP server may connect to it |

---

## Configure the agent file

Agents are one JSON file each under `~/.jazz/agents/<id>.json`:

```json
{
  "id": "1MeNdd1bmkf498bzCoTGKL",
  "name": "reviewer",
  "config": {
    "persona": "coder",
    "llm": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "reasoning": "medium"
    }
  }
}
```

Useful optional fields:

| Field                 | Effect                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.reasoning`       | `disable`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The selected model validates the control surface.                                                                 |
| `llm.temperature`     | Sampling temperature from `0` to `2`. Not asked by the wizard. Unset means Jazz sends nothing and the provider's default applies; models that reject a custom temperature ignore it |
| `llm.summarizerModel` | `provider/model` used for context compaction **and** `execute_command` risk classification: point it at something cheap                                                             |
| `customTools`         | Declare extra tools (`record` or `command` handlers) without changing Jazz. See [Agent configuration](../configure/agents.md#custom-tools)                                          |
| `companions`          | Bind specialist `provider/model` pairs for image, audio, or video analysis and generation without changing the primary model; see [Model companions](../concepts/media.md)          |
| `envAllowlist`        | Exempt specific env vars from secret scrubbing for `execute_command`                                                                                                                |
| `deniedTools`         | Remove named tools from this agent after every other capability source is applied                                                                                                   |

`createdAt` and `updatedAt` are optional in a file you write by hand. Jazz stamps them when it creates or saves the agent, and falls back to the file's own created and modified times when they are absent.

The `tools` field adds capabilities; it does not restrict built-in tools. Use `deniedTools`
for restrictions. See [Agent configuration](../configure/agents.md) for every field, including
skill selection and memory scopes.

---

## Copying an agent

To start from an existing agent, copy its file:

```bash
cp ~/.jazz/agents/<id>.json ~/.jazz/agents/reviewer-strict.json
# edit id + name so they don't collide, then adjust
```

The `id` must be unique; `name` is what you type on the command line.

---

## Choosing a model

- **For digests and summaries:** try a fast, inexpensive model and check the output against the source material.
- **For code changes, reviews, and other multi-step tasks:** choose a model that handles reasoning and tool use reliably. Test it on representative work before scheduling it unattended.
- **A self-hosted model (`ollama`, `llamacpp`, `vllm`, `sglang`) when prompts must stay on your infrastructure.** No provider key unless the server requires one, and no provider per-token cost. Network-capable tools and exporters remain separate choices; see [Local and air-gapped models](./local-models.md).
- **A cheaper `llm.summarizerModel` for supporting calls.** It handles both compaction and command-risk classification. Check that it can do both reliably.
- **Primary model for orchestration, companions for media.** Keep the tool-capable model you trust and route image, audio, or video understanding and generation to specialists.

If a task turns out harder than expected, switch to an agent configured with a stronger model using `/switch` (or `/models`).

---

## Next steps

- [Personas](../concepts/personas.md): define reusable behavior and voice
- [Tools](../concepts/tools.md): what it can do, and what the risk tiers mean
- [Workflows](../concepts/workflows.md): run it on a schedule
- [Model companions](../concepts/media.md): tune one agent with several specialist models

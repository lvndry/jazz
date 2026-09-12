---
description: "Configure a Jazz agent for a specific job: system prompt, model, provider, skills, and tool policy: defined in a single AGENT.md file."
---

# Creating agents

How to get an agent configured for a specific job.

```bash
jazz agent create
```

That's an interactive wizard: name, provider and model, persona, toolset, skills. There are
**no command-line flags** on `create`; if you want to script agent creation, write the JSON
file directly (shape below) or copy an existing one.

---

## What the wizard asks

| Choice               | Guidance                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**             | How you'll refer to it: `jazz agent chat reviewer`                                                                                                                                                                                     |
| **Provider + model** | See [Providers](../configure/providers.md). `openrouter` with a free model costs nothing; `ollama` keeps everything local unless you pick a `:cloud` model, which needs an [Ollama API key](../configure/providers.md#ollama-cloud)    |
| **Persona**          | `default`, `coder`, `researcher`, or one of yours. See [Personas](../concepts/personas.md)                                                                                                                                            |
| **Toolset**          | Extra capabilities to add, including configured MCP servers. Built-in tools are supplied by the persona's tool profile; use `deniedTools` in the agent file for hard per-agent restrictions. Selecting an MCP server may connect to it |
| **Skills**           | Maintained instructions it can load on demand. See [Skills](../concepts/skills.md)                                                                                                                                                    |

---

## The file

Agents are one JSON file each under `~/.jazz/agents/<id>.json`:

```json
{
  "id": "1MeNdd1bmkf498bzCoTGKL",
  "name": "reviewer",
  "config": {
    "persona": "coder",
    "llmProvider": "anthropic",
    "llmModel": "claude-sonnet-4-5",
    "tools": ["read_file", "grep", "find", "ls", "execute_command"],
    "reasoningEffort": "medium"
  }
}
```

Useful optional fields:

| Field             | Effect                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoningEffort` | `low` \| `medium` \| `high` \| `disable`. Models without reasoning support error unless this is `disable`                                                                           |
| `temperature`     | Sampling temperature from `0` to `2`. Not asked by the wizard. Unset means Jazz sends nothing and the provider's default applies; models that reject a custom temperature ignore it |
| `summarizerModel` | `provider/model` used for context compaction **and** `execute_command` risk classification: point it at something cheap                                                            |
| `customTools`     | Declare extra tools (`record` or `command` handlers) without changing Jazz. See [Agent configuration](../configure/agents.md#custom-tools)                                         |
| `companions`      | Bind specialist `provider/model` pairs for image, audio, or video analysis and generation without changing the primary model; see [Model companions](../features/media.md)          |
| `envAllowlist`    | Exempt specific env vars from secret scrubbing for `execute_command`                                                                                                                |
| `deniedTools`     | Remove named tools from this agent after every other capability source is applied                                                                                                   |

Full field reference: [Agent configuration](../configure/agents.md).

---

## Copying an agent

Cloning is usually faster than the wizard, and it's how the
[Telegram](../../packages/telegram-bot/) and
[Discord](../../packages/discord-bot/) bridges give every chat its own agent:

```bash
cp ~/.jazz/agents/<id>.json ~/.jazz/agents/reviewer-strict.json
# edit id + name so they don't collide, then adjust
```

The `id` must be unique; `name` is what you type on the command line.

---

## Choosing a model

There's no single best answer, but a few reliable calls:

- **A cheap fast model for scheduled digests and CI review.** These read and summarize; they don't need frontier reasoning, and they run often enough for cost to matter.
- **A strong model for anything multi-step or ambiguous.** Long autonomous runs are where weak models lose the thread, and a failed 40-minute run costs more than the model would have.
- **A local model (`ollama`, `llamacpp`) when prompts must stay local.** No provider key or per-token cost. Network-capable tools and exporters remain separate choices; see [Local and air-gapped models](./local-models.md).
- **`summarizerModel` cheap, main model expensive.** Compaction is summarization; it rarely needs your best model, and it runs on long tasks precisely when you're already spending.
- **Primary model for orchestration, companions for media.** Keep the tool-capable model you trust and route image, audio, or video understanding and generation to specialists.

If a task turns out harder than expected, switch to an agent configured with a stronger model using `/switch` (or `/models`).

---

## Next steps

- [Personas](../concepts/personas.md): change how it talks without touching what it knows
- [Tools](../concepts/tools.md): what it can do, and what the risk tiers mean
- [Workflows](../concepts/workflows.md): run it on a schedule
- [Model companions](../features/media.md): tune one agent with several specialist models
- [Evals](../maintainers/testing-and-evals.md): measure whether a config change actually helped

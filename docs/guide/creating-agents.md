# Creating agents

**Reader job:** get an agent configured for a specific job.

```bash
jazz agent create
```

That's an interactive wizard — name, provider and model, persona, toolset, skills. There are
**no command-line flags** on `create`; if you want to script agent creation, write the JSON
file directly (shape below) or copy an existing one.

---

## What the wizard asks

| Choice | Guidance |
| --- | --- |
| **Name** | How you'll refer to it: `jazz agent chat reviewer` |
| **Provider + model** | See [Providers](../integrations/providers.md). `openrouter` with a free model costs nothing; `ollama` keeps everything local |
| **Persona** | `default`, `coder`, `researcher`, or one of yours — see [Personas](../concepts/personas.md) |
| **Toolset** | The tools this agent may call. Every category starts checked — **untick down to the minimum.** Omitting `execute_command` means it can never run a shell command, whatever the approval policy. Configured MCP servers start unchecked, since selecting one connects to it |
| **Skills** | Playbooks it can load on demand — see [Skills](../concepts/skills.md) |

---

## The file

Agents are one JSON file each under `~/.jazz/agents/<id>.json`:

```json
{
  "id": "1MeNdd1bmkf498bzCoTGKL",
  "name": "reviewer",
  "model": "anthropic/claude-sonnet-4-5",
  "config": {
    "persona": "coder",
    "llmProvider": "anthropic",
    "llmModel": "claude-sonnet-4-5",
    "tools": ["read_file", "grep", "find", "ls", "git_diff", "git_log", "git_status"],
    "reasoningEffort": "medium"
  }
}
```

Note that `model` is the combined `provider/model` string while `llmProvider` and `llmModel`
hold it split — the separator is a **slash**, not a colon.

Useful optional fields:

| Field | Effect |
| --- | --- |
| `reasoningEffort` | `low` \| `medium` \| `high` \| `disable`. Models without reasoning support error unless this is `disable` |
| `summarizerModel` | `provider/model` used for context compaction — point it at something cheap |
| `customTools` | Declare extra tools (shell or HTTP) with no code — see [Configuration](../reference/configuration.md#agent-config-customtools) |
| `envAllowlist` | Exempt specific env vars from secret scrubbing for `execute_command` |
| `maxIterations` | Override the 80-iteration default |

Full field reference: [Configuration](../reference/configuration.md).

---

## Copying an agent

Cloning is usually faster than the wizard, and it's how the
[Telegram](../../integrations/telegram-bot/) and
[Discord](../../integrations/discord-bot/) bridges give every chat its own agent:

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
- **A local model (`ollama`, `llamacpp`) for anything private.** No key, no per-token cost, no data leaving the machine. Needs a tool-capable model — see [Airgapped](./airgapped.md).
- **`summarizerModel` cheap, main model expensive.** Compaction is summarization; it rarely needs your best model, and it runs on long tasks precisely when you're already spending.

Switch mid-conversation with `/model` when a task turns out harder than expected.

---

## Next steps

- [Personas](../concepts/personas.md) — change how it talks without touching what it knows
- [Tools](../concepts/tools.md) — what it can do, and what the risk tiers mean
- [Workflows](../concepts/workflows.md) — run it on a schedule
- [Evals](../internals/evals.md) — measure whether a config change actually helped

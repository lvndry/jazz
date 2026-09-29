---
description: "Create and configure Jazz agents with their own models, personas, tools, skills, memory, context limits, and media companions."
---

# Agents

An agent combines a model, persona, tools, skills, and memory settings in one configuration
file. Create separate agents for tasks that need different models or permissions.

For example, keep a coding agent for repository changes, a researcher for web investigation,
and a reviewer with fewer permissions for unattended work.

## Create and use an agent

```bash
jazz agent create
jazz agent chat <agent-name>
```

The wizard lets you choose its model, persona, name, and tools. Ask it for a task, such as:

```text
Read the current changes, identify bugs, and suggest fixes. Do not modify files yet.
```

Use `jazz agent edit <agent-name>` to change its settings. Changes take effect on the next turn.
See [Creating agents](../getting-started/create-an-agent.md) for the walkthrough.

## What an agent is made of

- **Identity:** its name and description.
- **Model:** the provider and model that handle reasoning and tool use.
- **Persona:** reusable instructions for its behavior and voice.
- **Tools:** the actions it can request, including explicit denials.
- **Skills:** procedures it can load when needed.
- **Companions:** optional specialist models for images, audio, and video.
- **Memory and context settings:** what it remembers and how much history it carries.

Example agent file:

```json
{
  "id": "reviewer",
  "name": "Reviewer",
  "config": {
    "persona": "coder",
    "llm": {
      "provider": "openai",
      "model": "gpt-5.4"
    }
  }
}
```

`jazz agent create` writes one interactively. Files live under the active Jazz data directory
and are shared by every surface using that installation, so the same agent answers in your
terminal, in CI, and on Telegram.

### Model

Written `provider/model` with a **slash**: `openrouter/z-ai/glm-5.3-flash`,
`mistral/mistral-large-latest`, `ollama/qwen3`. Stored split into
`llm.provider` and `llm.model`. Local providers are also supported; see [Model providers](../configure/providers.md).

### Persona

Shapes _how_ the agent communicates (tone, style, vocabulary) independently of the model.
Ships with `default`, `coder`, and `researcher`, and you can write your own. See
[Personas](./personas.md).

### Tools

- **`tools` is additive.** It grants capabilities _on top of_ the built-in bundle the persona
  already permits. Listing a built-in tool changes nothing, and leaving one out does **not**
  withhold it.
- **`deniedTools` subtracts, last.** It is applied after every other grant, which makes it the
  reliable way to enforce a per-agent ceiling. An agent with `execute_command` denied cannot run
  shell commands, whatever the approval policy says.

Use `deniedTools` to remove capabilities the job does not need. See [Tools](./tools.md).

### Context budget

`llm.maxContextTokens` caps how much conversation this agent may carry, in tokens, whatever the
model would allow. Unset, it uses the model's own window. Set it to keep cost and latency
predictable, or to stop a model degrading long before its advertised limit: the agent warns at
70% of the budget and auto-compacts at 80%, so a smaller ceiling means earlier, cheaper
compaction rather than a hard failure. See [Context management](./context-management.md).

### Skills

Skills are **not** bundles of tools. They are playbooks: Markdown instructions the agent loads
on demand when a task matches. Two agents can have identical tools and differ entirely in which
skills they reach for. See [Skills](./skills.md).

### Companions

`companions` lets one identity borrow specialist models without switching its main model.
Analysis and generation bind independently, per medium:

```json
{
  "companions": {
    "analyze:image": "provider/vision-model",
    "analyze:audio": "provider/audio-model",
    "generate:image": "provider/image-generation-model"
  }
}
```

A companion run is bounded, tool-free, and isolated: analysis returns evidence, generation
returns a file, and neither creates a second identity or conversation. A cheap text model can
orchestrate the work while a vision model does the looking. See
[Model companions](./media.md).

---

## Project instructions (AGENTS.md)

Jazz reads [`AGENTS.md`](https://agents.md), the standard file for project instructions.
Add your build commands, test commands, and coding conventions at the repository root.
Every Jazz agent working there reads it automatically.

Discovery runs on each turn against the agent's current working directory:

| Order | File                       | Purpose                                      |
| ----- | -------------------------- | -------------------------------------------- |
| 1     | `~/.agents/AGENTS.md`      | Your personal defaults, across every project |
| 2     | `<repo root>/AGENTS.md`    | How this project works                       |
| 3     | `<subdirectory>/AGENTS.md` | Overrides for one package or area            |

The walk climbs from the working directory to the repository root, the nearest ancestor with a
`.git`, and stops there, so a checkout never inherits an unrelated `AGENTS.md` from a directory
above it. Files enter the system prompt outermost-first, so **when two conflict, the more
specific one wins**. Each file is capped at 32 KB; keep them short and they stay effective.

Edits take effect on the next turn. Nothing to restart.

---

## Agent configurations

| Pattern         | Shape                                           | Good for                                  |
| --------------- | ----------------------------------------------- | ----------------------------------------- |
| **Generalist**  | broad: files, git, web, shell                   | Daily driver in your terminal             |
| **Specialist**  | narrow: reads and greps, everything else denied | CI review, anything unattended            |
| **Delegator**   | adds `spawn_subagent`                           | Parallel research and independent checks  |
| **Mixed-model** | cheap main model plus `companions`              | Screenshots, recordings, generated assets |

### Delegation

Use subagents for independent work that can happen in parallel, such as reviewing separate
packages or researching different approaches. Ask the parent agent to divide the work:

```text
Have subagents review the API, database, and frontend changes separately.
Combine their findings, verify each issue, and report the fixes we need.
```

The parent needs `spawn_subagent` in its toolset. You see child activity while it works;
the parent collects their results into one answer.

`spawn_subagent` hands a task to a child run on
this same installation, with a task, a persona (`coder`, `researcher`, or `default`), and its own
context window. It returns an `agentId` at once and the child works while the parent keeps going;
the parent collects the child's answer with `wait_subagents`, and gets back a summary and the
cost, not the child's transcript.

Each child has its own context window. Use `resultSchema`, a JSON Schema with root type
`object`, to require a validated structured result.

While children work, the parent can manage them:

| Tool             | What it does                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `wait_subagents` | Waits until any or all of them finish, and returns their results in one call                   |
| `list_subagents` | Each child's status (running, paused, waiting on an approval, done), activity and spend so far |
| `steer_subagent` | Sends a child new guidance, pauses it, resumes it or cancels it                                |

An agent granted `spawn_subagent` gets these three with it. Guidance and pauses take effect
before the child's next model call, and a paused child spends nothing. Cancelling stops it at
once, with the tools and processes it started. A child that finishes is announced to the parent
on its next step, and guidance a child finished too early to read is reported back as
`undeliveredMessages`.

Delegation limits:

- **A child never holds more tools than its parent.** The parent's effective toolset becomes the
  child's allowlist, so delegation cannot widen reach.
- **Depth stops at 3.** A subagent can spawn one, but the chain ends there. `maxSubagentDepth: 0`
  disables delegation outright.
- **At most four at once,** each with **30 iterations** by default, against the parent's 100.
- **Cost rolls up and is shared.** Each child's spend is added to the parent's as it happens, so
  children running together stop at the parent's `maxCostUSD` instead of each spending the whole
  remainder. An unpriced child marks the total cost as unknown.
- **Children never outlive the turn.** If the parent answers while children are still going,
  Jazz cancels the paused ones, waits for the rest, and gives the parent one more step to read
  their results. Work that should continue after the turn is a
  [goal](./goals-and-loops.md). A run that parks or detaches stops its children; a
  resumed run starts with none.
- **Their approvals name them.** In chat, a child's approval prompt starts with its name. In an
  unattended run, a child's gated call is declined and the child reports that to the parent.

A subagent is not a [peer](./agent-to-agent.md). A subagent is yours, on your machine, inside
your trust boundary. A peer belongs to somebody else and is bounded by a disclosure tier because
of it.

---

## Editing agents and managing conversations

Agents are one JSON file each under the Jazz data directory (`~/.jazz/agents/<id>.json` by
default). Edit them with `jazz agent edit <id>`, or by hand.

Conversations persist separately, per conversation id. In the terminal, `/resume` browses past
ones, `/start` starts a fresh one, `/new` creates an agent, `/rename` names the current conversation, and `/fork` continues on a new conversation id while carrying the
full history forward and preserving the original branch (resume it later with `/resume`); headless
callers
pass `--conversation <id>` to continue the same thread across invocations. Transcripts are plaintext JSON: treat that
directory as sensitive.

---

## Related

- [Create an agent](../getting-started/create-an-agent.md): the practical walkthrough
- [Agent configuration](../configure/agents.md): every field
- [Personas](./personas.md) · [Skills](./skills.md) · [Tools](./tools.md)
- [Starting runs](./starting-runs.md): terminal commands, workflows, schedules, and events

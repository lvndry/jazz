# Agents

**Reader job:** understand what an agent is made of, so you can configure one deliberately.

An agent is the thing that does the work. Unlike a chatbot that answers one prompt and stops,
an agent runs a loop: it reads the situation, calls tools, observes what came back, and keeps
going until the task is done or its budget runs out.

---

## What an agent is made of

```mermaid
flowchart TB
    A["<b>Agent</b><br/>~/.jazz/agents/&lt;id&gt;.json"]

    A --> ID["<b>Identity</b><br/>id · name"]
    A --> M["<b>Model</b><br/>llmProvider + llmModel<br/><i>e.g. openrouter/qwen3</i>"]
    A --> P["<b>Persona</b><br/>tone and style<br/><i>default · coder · researcher</i>"]
    A --> T["<b>Toolset</b><br/>explicit list of tool names<br/><i>omission is a security control</i>"]
    A --> S["<b>Skills</b><br/>playbooks it may load"]
    A --> X["<b>Extras</b><br/>reasoningEffort · summarizerModel<br/>customTools · envAllowlist"]

    classDef key fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    class T key
```

### Model

Written `provider/model` with a **slash** — `openrouter/qwen/qwen3-next-80b-a3b-instruct:free`,
`anthropic/claude-sonnet-4-5`, `ollama/qwen3`. Stored split into `llmProvider` and `llmModel`.
Eighteen providers are available; see [Providers](../integrations/providers.md).

### Persona

Shapes *how* the agent communicates — tone, style, vocabulary — independently of the model.
See [Personas](./personas.md).

### Toolset

An explicit list of tool names the agent may call, e.g. `read_file`, `grep`, `git_commit`.
**This is the strongest safety control available:** an agent whose list omits
`execute_command` cannot run shell commands, no matter what approval policy is set. Give each
agent the fewest tools its job needs. See [Tools](./tools.md).

### Skills

Skills are **not** bundles of tools — they are playbooks: markdown instructions the agent loads
on demand when a task matches. Two agents can have identical toolsets and differ entirely in
which skills they reach for. See [Skills](./skills.md).

---

## The execution loop

```mermaid
flowchart LR
    T["Task"] --> TH["<b>Think</b><br/>read history,<br/>decide next step"]
    TH --> AC["<b>Act</b><br/>call one or more tools<br/>(gated ones ask first)"]
    AC --> OB["<b>Observe</b><br/>results enter context"]
    OB --> Q{"Done?"}
    Q -->|no| TH
    Q -->|yes| R["<b>Respond</b>"]

    classDef act fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    class AC act
```

Up to 80 iterations by default, with guards that keep long runs from spiralling — budget
pressure, loop detection, and automatic context compaction. The full mechanism:
[Agent loop](../internals/agent-loop.md).

---

## Patterns worth copying

| Pattern | Toolset | Good for |
| --- | --- | --- |
| **Generalist** | broad — files, git, web, shell | Daily driver in your terminal |
| **Specialist** | narrow — e.g. reads and greps only | CI review, anything unattended |
| **Delegator** | includes `spawn_subagent` | Deep research, work that would blow one context window |

The delegator pattern works today: `spawn_subagent` hands a task to a child agent with its own
context window, which returns a summary rather than 100k tokens of raw sources. See
[Sub-agents](../internals/subagents.md).

---

## Storage and memory

**Agents** live one JSON file each in `~/.jazz/agents/<id>.json`. Edit them with
`jazz agent edit <id>`, or by hand.

**Conversations persist.** Transcripts are stored per conversation id under
`~/.jazz/history/`, LRU-bounded to 100 conversations per agent. In the terminal you switch
between them with `/switch`; headless callers pass `--conversation <id>` and get the same thread
back across invocations — which is what gives a chat bridge memory without storing anything
itself. See [Headless](../surfaces/headless.md#memory-without-a-database).

Transcripts are plaintext JSON. Treat that directory as sensitive.

---

## Related

- [Creating agents](../guide/creating-agents.md) — the practical walkthrough
- [Personas](./personas.md) · [Skills](./skills.md) · [Tools](./tools.md)
- [Agent loop](../internals/agent-loop.md) — what happens during a run
- [Configuration](../reference/configuration.md) — every agent config field

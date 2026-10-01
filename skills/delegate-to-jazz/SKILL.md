---
name: delegate-to-jazz
description: Delegate a task to one of the user's local Jazz agents via the jazz CLI, choosing the cheaper, local, or more capable model per task. Use when the user says "delegate to jazz", "offload this to another agent", "run this on a jazz agent", "use a cheaper model for this", "ask one of my agents to", or when a bulky, independent, or long-running subtask should be routed to a different model or provider than the current one.
---

# Delegate to Jazz

Hand a self-contained task to one of the user's local Jazz agents through the `jazz` CLI.
The point of delegation is choosing a different model per task: a local agent for free
offline work, a nano/mini agent for high-volume mechanical work, a frontier agent for
hard problems, a specialist persona for the tone the job needs.

The current agent (Claude Code, Codex, or any other harness) only picks the agent and
relays the result. It does not do the delegated work itself.

## Workflow

- [ ] 1. Enumerate agents
- [ ] 2. Let the user pick (or confirm your pick)
- [ ] 3. Draft a self-contained prompt
- [ ] 4. Dispatch with `jazz run`
- [ ] 5. Relate the result back

### 1. Enumerate agents

Always re-enumerate at delegation time — the local agent config changes, and a name
that worked yesterday may not exist today.

```bash
jazz agent list --json
```

Build a compact table from the `agents` array (fields: `name`, `id`, `provider`,
`model`, `persona`, `reasoning`). Report entries under `problems` — those agents exist
but have broken config (unknown provider or reasoning level) and cannot be delegated
to.

### 2. Pick the agent

**The user picks.** Present the table with a one-line hint per candidate: what the
provider/model is, local (free, offline) vs hosted (costs tokens), persona, and
reasoning level. Then ask the user to choose by name.

Only skip the question when the user already named a specific agent or gave a clear
preference ("use the cheapest", "use something local"). In that case make your pick,
state it and why in one line, and proceed — a wrong pick costs one run, a blocking
question costs a round trip.

Heuristics for suggesting candidates:

- **Free / offline / air-gapped** → agents with `provider` of `vllm`, `llamacpp`, or
  `ollama`.
- **Cheap, mechanical, high-volume** (rename files, summarize, extract, format) →
  nano/mini-class models, `*openrouter/free*` or `orcarouter/free` models.
- **Hard reasoning, long context, high stakes** → frontier models, higher
  `reasoning` levels (`high`, `xhigh`).
- **Tone or role matters** → match `persona` to the job.
- **`eval-*` agents** exist for the eval harness; suggest them only if the user means
  eval work.
- **Duplicate names** (two agents can share a `name`): disambiguate by provider/model,
  and always dispatch by the agent's `id` when names collide.

### 3. Draft a self-contained prompt

The delegated agent starts fresh: no knowledge of the current conversation, and its
working directory is yours only if you pass it. The prompt must carry:

- the task, with enough context to execute without asking questions back
- explicit working directory or target file paths
- constraints (what must not change, budgets, required format)
- the exact output shape you expect (prose, JSON, file path, diff)

If the task needs input data that is not on disk, write it to a file first and reference
the path — keep the prompt on argv short.

### 4. Dispatch

```bash
jazz run --agent <id-or-name> --approval-policy low-risk \
  --watch tools,usage,spend,approval --json "<prompt>"
```

Flag guidance:

- `--agent` takes an id or name. Use the **id** whenever two agents share a name.
- `--approval-policy` is required in practice: with nobody to answer, tools above the
  tier are declined. Pick the lowest tier that finishes the job: `read-only` for
  pure analysis, `low-risk` when it may run benign commands, `high-risk` for file
  writes and shell mutations. State which tier you chose and why.
- `--max-cost-usd <n>` for hosted providers on open-ended tasks — a number you are
  willing to lose, checked between iterations.
- `--watch tools,usage,spend,approval` keeps the delegating agent in the loop
  instead of staring at a black box: NDJSON progress lines on stderr name each tool
  call, token usage, cumulative spend, and every approval decision, so the agent can
  see the work is moving, notice a dead end early, and report progress to the user.
  `--watch` is an alias of `--events` (same categories: tools,reasoning,text,usage,
  approval,subagent,spend,all) and only takes effect together with `--json` — the
  one-shot layer is what writes NDJSON. `--watch all` only for debugging — it adds
  reasoning and text deltas and floods stderr.
- `--max-duration-ms <ms>` when the task has a deadline.
- `--reasoning <effort>` to push a hard task onto a stronger thinking level than the
  agent's default.
- Long or sensitive prompts: write the prompt to a file and pipe it — `jazz run`
  reads piped stdin when there is no positional prompt:
  `cat /tmp/task-prompt.md | jazz run --agent <id> --approval-policy low-risk --json`.

This list covers the flags delegation actually needs, not the whole surface. When a flag
behaves unexpectedly, or you need one not listed here, ask the CLI itself — `jazz help run`
or `jazz run --help` prints every option with its description, and the Jazz docs have the
full contract. Trust those over memory: flag names and behaviors change between releases.

**Result contract:** stdout carries exactly one JSON envelope:
`{ ok: true, answer, costUSD, tokenUsage, toolCalls }` on success, or
`{ ok: false, error, code }` on failure. With `--watch` set (and `--json`), stderr
carries NDJSON progress events, one per line: `tool_execution_start`,
`tool_execution_complete`, `usage_update`, `run_spend`, `approval_required`,
`approval_resolved`, plus an `error` event that is always emitted — parseable, not
just for humans. Watch a `run_spend` line climbing toward `--max-cost-usd` and
mention it in the report; a run that stops producing events for a long stretch is
the first sign it is stuck.

### 5. Relate the result back

Report the delegated agent's answer as its own, plus the cost if present in
`costUSD` — the user chose this agent partly for the bill, and the price is the
evidence that the choice paid off. On `ok: false`, read `code`:

- provider/auth errors → the chosen agent's model is not reachable; say so and offer
  the next-best agent from the table
- `content_filtered` → relay the answer honestly; do not silently re-ask
- `truncated` / `iterationLimited` → the task outgrew the run's budgets; report that
  and suggest a bigger budget or a stronger agent, not a silent retry

One delegation can fan out: dispatch several `jazz run` calls against different agents
in parallel and cross-check their answers. Name which agent said what in the report.

## Troubleshooting

| Symptom                              | Likely cause / action                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `jazz: command not found`            | Jazz not installed or not on PATH; ask the user to check or install (`bun install -g jazz-ai --trust`)                         |
| `jazz agent list --json` fails       | Jazz home missing or corrupted; the `problems` array usually names the cause                                                   |
| Agent in `problems`                  | Unknown provider or reasoning level in its config; the user can fix it with `jazz agent edit <id>`                             |
| Run fails with a provider auth error | The agent's provider key is missing/expired in `$JAZZ_HOME`; suggest a working agent                                           |
| Run never ends, no events at all     | Local server (llama.cpp, Ollama, vLLM) is down — verify it responds, then retry; there is no default `--timeout` on `jazz run` |
| Run returns empty or `no_answer`     | The prompt was too ambiguous for the weaker model; sharpen it and retry once                                                   |

## Notes

- The delegated run has its own conversation history and memory; it does not see this
  one. `--conversation <id>` (optional) gives a delegated job stable state across runs.
- Do not delegate the task back to an agent whose model is the same one this
  conversation runs on unless the user asked for it — that defeats the point.
- A Jazz agent can also delegate: if you are already inside Jazz and want to bounce a
  task to another local agent, the same `jazz run` contract applies.

---
description: "How Jazz manages long agent runs: context limits, automatic compaction, saved work state, tool-result retrieval, run budgets, and stall detection."
---

# Context management

Context management controls what Jazz sends to the model on each request: conversation
messages, instructions, tool definitions, and tool results.

Each model has a **context window**, the amount of text it can receive in one request. As a
conversation grows, Jazz makes room by removing older tool output and summarizing older
messages. The agent's saved work state keeps the task's objective and decisions available.

## Managing conversation history

Jazz manages context automatically. By default:

| Context used | Action                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------ |
| 50%          | Replace older large tool results with retrieval pointers, keeping recent results intact          |
| 70%          | Warn that the context is filling and ask the agent to save its findings                          |
| 80%          | Summarize older history while keeping system instructions, pinned messages, and recent exchanges |
| 95%          | Trim older messages if the history still exceeds the limit                                       |

These percentages use the model's effective context window, lowered by the agent's
`llm.maxContextTokens` when configured. The warning and compaction thresholds can be changed in
[Jazz configuration](../configure/jazz.md#context-management).

**Compaction** replaces older exchanges with a summary so the agent can continue the same task.
Jazz shows when it happens. It uses an additional model call and can lose detail; `llm.summarizerModel`
selects the model for that call. The agent can also request compaction with `summarize_context`.

**Trimming** removes older messages without summarizing them. Jazz uses it when compaction
cannot free enough space or the summarizer fails. Tool calls and their results stay paired,
and Jazz tells you when history is discarded.

## Keeping findings available

**Work state** records the task's objective, decisions, open questions, and next step.
**Todos** track progress and verification. Both survive compaction.

Jazz saves large tool outputs separately. When an older output is removed from context, or an
output is too long to show whole, the agent can read the saved copy a page at a time with
`retrieve_tool_result`. If saving failed, it must rerun the tool.

Use [memory](./conversations-and-memory.md) for facts needed across conversations and files or
the scratchpad for longer drafts and research material.

## Setting run limits

A run defaults to 100 iterations, where each iteration is a model call and any tools it requests.
Cost, token, and duration caps are unset until you configure them. Set limits globally,
in a workflow, or for one `jazz run` invocation.

Jazz warns the agent as its budgets fill, giving it time to consolidate findings and finish.
Iteration, cost, and token limits are checked between iterations, so an in-flight call can
cross them. A duration cap interrupts running work at its deadline.

See [Budgets](./budgets.md) for configuration, enforcement, and spend reporting.

## Detecting stalled work

Jazz monitors repeated tool calls. If fewer than 40% of the last ten calls have distinct
names and arguments, it asks the agent to change approach. If repetition continues through
another full window, Jazz stops the run and reports `stalled: true` in `jazz run --json`.

Calls with different arguments count as different work. This detects exact repetition;
it may miss an agent repeating the same approach with slightly different arguments.

## Continuing beyond a run

[Goals](./goals-and-loops.md) continue an objective across successive turns.
[Remote handoff](./detach.md) moves a conversation to your SSH server so it can continue
after you close your laptop.

## Read the prompt-cache hit rate

Providers bill input they already hold in a prompt cache at a lower rate and answer faster.
Jazz shows how much of each request was served from cache, so you can tell a cheap turn from
an expensive one.

- The turn receipt after each answer ends with `cache 82%` when the provider reported cache
  figures. Press Ctrl+O on a multi-step turn for the per-step rates.
- `/context` shows a `cache` row for the last request in the conversation.
- `jazz run --json` adds `cacheHitRate` (0 to 1) and `cacheMissReason` to `tokenUsage`.

The rate is cache reads divided by all input tokens of the request. A provider that reports
no cache figures shows `unknown`, or no cache figure on the receipt, never 0%.

When the rate is below 50%, the receipt adds what changed in the cacheable prefix compared
with the previous request in the conversation:

| Reason                  | Meaning                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `first request`         | Nothing was sent before in this process, so nothing could be cached.          |
| `prefix unchanged`      | Only messages were appended. The provider still missed (see below).           |
| `tools changed`         | The tool definitions differ, for example after a deferred tool was unlocked.  |
| `system prompt changed` | The system prompt differs: date, memory, instructions, or skills changed.     |
| `history rewritten`     | Earlier messages changed: compaction, clearing old tool results, or trimming. |
| `model changed`         | A different model answered, so its cache is separate.                         |
| `provider changed`      | A different provider answered.                                                |

Jazz compares what it sends. A changed prefix is a likely cause of a miss, not a proof, and an
unchanged prefix does not promise a hit: providers expire cached prefixes on their own.
Anthropic drops them after 5 minutes without a request, so a pause between turns shows a low rate
with `prefix unchanged`. Requests seconds apart inside one tool loop are where the rate is
expected to be high. Run with `--debug` to log each request's classification and the
hashes that changed; prompt content is never logged.

## Adjust the context limit

For an agent that reads many large files, set `llm.maxContextTokens` in its `config` to compact
earlier. For example:

```json
{ "llm": { "maxContextTokens": 64000 } }
```

Choose a limit no larger than the model's supported window. Earlier compaction reduces the
history sent per request, but may require the agent to retrieve or reread more details.
See [Agent configuration](../configure/agents.md) for the full file format.

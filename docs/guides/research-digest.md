---
description: "Schedule a Jazz multi-agent research radar that finds genuinely new work, challenges weak sources, and produces a cited weekly briefing without mutating external systems."
---

# Build a weekly multi-agent research radar

Use this workflow to track a technical field without receiving a keyword dump every week. Jazz gives separate subagents responsibility for discovery, source quality, and contrarian checking; the parent publishes only claims that survive reconciliation.

The scheduled workflow is read-only. Its report appears in Jazz workflow output and history, so it needs no invented “digest” integration and no permission to write arbitrary files.

## 1. Configure web search

Choose one supported provider and verify it with an interactive agent before scheduling. See [Web search](../configure/web-search.md) for current provider fields and query differences.

The research agent needs `web_search`, `web_fetch`, `http_request`, `spawn_subagent`, and context tools. Create or edit an agent named `research-radar` and keep mutation tools denied.

## 2. Create the workflow

Create `~/.jazz/workflows/agent-harness-radar/WORKFLOW.md`:

```markdown
---
name: agent-harness-radar
description: "Weekly evidence briefing on open-source AI agent harnesses"
schedule: "0 8 * * 1"
agent: research-radar
autoApprove: low-risk
catchUpOnRestart: true
maxCatchUpAge: 172800
maxIterations: 70
maxCostUSD: 1.50
maxDurationMs: 900000
---

# Weekly agent-harness research radar

Find material published or released in the last seven days that changes how developers can build, evaluate, secure, or operate open-source AI agent harnesses.

Delegate three isolated investigations:

1. **Primary-source scout:** releases, changelogs, repositories, papers, and official engineering posts.
2. **Adoption scout:** concrete developer use, migration reports, benchmarks, and failure reports.
3. **Skeptic:** challenge novelty, publication dates, benchmark quality, and duplicated coverage.

Each investigator must return URLs, publication dates, one-sentence claims, and the evidence supporting those claims. Search current sources; do not answer from model memory.

Reconcile their results yourself. Drop items that are outside the date window, repeat another source, lack accessible evidence, or merely announce a feature without explaining its consequence.

Return:

## What changed

At most five items. For each: title, date, direct source URL, verified change, and why it matters.

## One claim worth testing

The most consequential claim, what evidence currently supports it, and a small reproducible test.

## Disagreements and uncertainty

Conflicting evidence, inaccessible sources, or conclusions the team could not verify.

## Quiet-week note

If nothing material changed, say so. Never pad the report to reach a target count.
```

Change the topic and source expectations to match the field you actually follow. A narrow decision-oriented question produces a better radar than “AI news.”

## 3. Test the exact scheduled policy

```bash
jazz workflow run agent-harness-radar --auto-approve
jazz workflow history agent-harness-radar
```

### What you should see

The four sections from the prompt, with a dated source on every claim:

```text
## What changed
- vLLM 0.12 ships prefix-caching for multi-turn tool calls (2026-03-28, release notes).
  Matters because our harness re-sends the same 12k system prefix on every iteration.

## One claim worth testing
- "Structured output removes the need for a validation pass" (vendor blog, 2026-03-31).
  Testable: run 200 delegations with and without schema validation, count malformed results.

## Disagreements and uncertainty
- Two benchmarks disagree on tool-call accuracy for the same model; neither publishes its
  harness. Treat both as unverified.

## Quiet-week note
Nothing new on context compaction this week.
```

That last section is the one to check. A week with no real news should produce the quiet-week note, not four items of filler. Verify every material claim has a direct source and date; a report that cannot establish recency should state that limitation rather than quietly including the item.

## 4. Schedule it

```bash
jazz workflow schedule agent-harness-radar
jazz workflow scheduled
```

The report remains available in workflow history and scheduler logs. If another system should deliver it, consume the headless JSON output from a controlled wrapper rather than granting the research agent a messaging credential.

## Why this is a Jazz workflow

- Subagents search from independent contexts instead of inheriting one early narrative.
- The skeptic has an explicit falsification job, not a generic “review this” prompt.
- The parent owns deduplication, contradiction resolution, and the final brief.
- Cost, time, and iteration budgets bound an unattended research fan-out.
- Search and provider choices can change without rewriting the schedule or research protocol.
- A quiet week is a valid machine outcome rather than a reason to hallucinate content.

Use a separate, human-approved workflow if the report should publish to a public channel or mutate a knowledge base. Research and publication do not need the same permissions.

Read [Automation](../features/automation.md), [Scheduled runs](../surfaces/scheduled.md), and [Delegation](../concepts/agents.md#delegation) for the underlying contracts.

---
description: "Schedule a Jazz multi-agent research radar that finds genuinely new work, challenges weak sources, and produces a cited weekly briefing without mutating external systems."
---

# Build a weekly multi-agent research radar

Track a technical field with separate subagents for discovery, source quality, and skeptical review. The parent reconciles their findings into a weekly briefing.

The report appears in workflow output and history. Keep mutation tools denied on the research agent.

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

Check that the report contains the requested sections and that each material
claim links to a source published in the last seven days. When nothing relevant
was published that week, it should say so.

## 4. Schedule it

```bash
jazz workflow schedule agent-harness-radar
jazz workflow scheduled
```

The report remains available in workflow history and scheduler logs. To receive it
on your phone or in chat, configure a [notification target](../configure/notifications.md)
and add `deliver: <target-name>` to the workflow frontmatter.

Read [Starting runs](../concepts/starting-runs.md), [Scheduled runs](../surfaces/scheduled.md), and [Delegation](../concepts/agents.md#delegation).

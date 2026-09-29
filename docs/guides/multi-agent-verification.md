---
description: "Build a Jazz multi-agent verification workflow with isolated reviewers, structured results, bounded budgets, and one accountable final verdict."
---

# Build a multi-agent verification council

Review a proposed technical change with three subagents: correctness, security,
and simplicity. Each starts with isolated context and returns a validated result.
The parent checks their evidence and produces the final verdict.

## 1. Create the reviewing agent

Run:

```bash
jazz agent create
```

Name it `change-council`, choose the `coder` persona, and ensure `spawn_subagent`, repository reading, and git inspection are available. Do not give it mutation tools for a review-only job.

## 2. Create the workflow

Add `workflows/change-council/WORKFLOW.md` to the repository:

```markdown
---
name: change-council
description: "Independently verify a proposed code change before implementation"
agent: change-council
autoApprove: read-only
maxIterations: 60
maxCostUSD: 1.00
maxDurationMs: 900000
---

# Independent change verification

Review the proposal in `PROPOSAL.md` against the current repository. Do not modify files.

Delegate these three questions to separate subagents so that each starts with fresh context:

1. **Correctness:** trace the affected code paths and identify false assumptions or missing failure modes.
2. **Security and operations:** identify changed trust boundaries, credentials, destructive actions, observability gaps, and rollback requirements.
3. **Simplicity:** search for existing abstractions and propose the smallest implementation that satisfies the stated outcome.

For each `spawn_subagent` call, set `resultName` to `review` and pass this object as
`resultSchema`:

{
"type": "object",
"required": ["verdict", "evidence", "risks"],
"properties": {
"verdict": { "type": "string", "enum": ["proceed", "revise", "block"] },
"evidence": { "type": "array", "items": { "type": "string" } },
"risks": { "type": "array", "items": { "type": "string" } }
}
}

Give each subagent only its question, the path to `PROPOSAL.md`, and permission to inspect the repository. Do not tell one reviewer what another concluded.

After all three return:

- reject any conclusion without file, symbol, test, or command evidence;
- resolve disagreements by inspecting the cited code yourself;
- distinguish verified facts from recommendations;
- return one verdict: `proceed`, `revise`, or `block`;
- list the minimum changes required before implementation.
```

`read-only` admits `spawn_subagent` and repository inspection. The workflow also
bounds iterations, cost, and wall-clock time.

## 3. Write a real proposal

Create `PROPOSAL.md` with the outcome, affected behavior, constraints, migration plan, and validation criteria. Describe the constraints without prescribing the implementation.

## 4. Run it with live delegation events

```bash
jazz workflow run change-council \
  --auto-approve \
  --json \
  --events subagent,tools,usage
```

The event stream shows each child start and finish while the final answer remains clean. Each child has isolated context and a bounded iteration budget inherited from Jazz's subagent configuration. Invalid structured output returns validation errors to the parent instead of silently becoming evidence.

### What you should see

A `subagent_start` and `subagent_complete` event on stderr for each reviewer:

```text
{"type":"subagent_start","agentName":"Sub-Agent (coder)","task":"Correctness: trace the affected code paths…"}
{"type":"subagent_complete","agentName":"Sub-Agent (coder)","durationMs":42000}
```

Then one envelope on stdout. `answer` is the parent's reconciliation, not a concatenation of the three reviews:

```json
{
  "ok": true,
  "answer": "VERDICT: revise. Re-open the upload stream on each retry (src/upload.ts:88). Reuse withRetry() from src/net/retry.ts.",
  "costUSD": 0.214,
  "costKnown": true,
  "tokenUsage": { "promptTokens": 48213, "completionTokens": 3102, "totalTokens": 51315 }
}
```

`costUSD` includes the children. An invalid `review` object returns validation errors
to the parent; check its final verdict explains how it handled any failed reviewer.

## 5. Use the verdict as a gate

In CI, capture the result with Jazz's headless output contract and require a human to accept `revise` or `block`. Do not let the reviewers merge code themselves. Review and mutation should remain separate capabilities.

For a stronger design, run this workflow before implementation and a separate [pull-request reviewer](./pr-review.md) afterward. The first challenges the plan; the second verifies what actually changed.

Read [Delegation](../concepts/agents.md#delegation) and [Context management](../concepts/context-management.md) for the execution model.

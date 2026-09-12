---
description: "Create a reusable Jazz accountability persona named Goggins, attach it to any model, and run it interactively, headlessly, or on a schedule."
---

# Build a Goggins accountability agent

This tutorial builds a direct accountability coach named `goggins`. The useful Jazz pattern is separation: the persona owns behavior, the agent chooses a model and capabilities, and the surface decides where and when it runs.

The result is one identity you can move between a terminal check-in, a script, a local model, and a scheduled review without copying the prompt.

## 1. Create the persona

Run:

```bash
jazz persona create
```

Use these answers:

- **Name:** `goggins`
- **Description:** `A demanding but constructive accountability coach that turns stated goals into measurable commitments.`
- **Tone:** `direct`
- **Style:** `concise`
- **System prompt:** paste the prompt below.

```text
You are Goggins, an accountability coach. Your job is to turn intention into an honest, measurable next action.

Be direct, concise, and constructive. Never insult, humiliate, diagnose, or imitate a real person's biography or catchphrases. Challenge excuses by asking for evidence and naming the gap between the stated goal and observed action.

For every check-in:
1. Restate the commitment and its deadline.
2. Separate completed work from explanations.
3. Ask for one concrete proof of progress when the claim is vague.
4. Reduce an oversized plan to the next action that can start now.
5. End with a commitment containing an action, a measurable result, and a time.

Do not invent progress. If prior context is unavailable, say so and ask for the baseline. Celebrate completed work briefly, then raise the next relevant standard.
```

Confirm what Jazz stored:

```bash
jazz persona show goggins
```

The persona is model-independent. It does not contain provider keys, schedules, or deployment settings, and it cannot grant itself tools.

## 2. Attach it to an agent

Run the agent wizard:

```bash
jazz agent create
```

Name the agent `accountability`, select any configured provider and model, and choose `goggins` as its persona. Start with no external integrations; an accountability check-in needs conversation, not broad machine access.

Test it in the foreground:

```bash
jazz agent chat accountability
```

Try:

```text
I want to ship the onboarding page by Friday. I have not broken down the work yet.
```

The response should produce a measurable commitment rather than generic motivation. If the behavior is wrong, change the reusable persona with `jazz persona edit goggins`; do not duplicate a revised prompt into the agent.

## 3. Use one conversation from a script

A stable conversation ID gives repeated check-ins continuity across separate processes:

```bash
jazz run --agent accountability \
  --conversation weekly-accountability \
  --json \
  "Monday check-in: my outcome for this week is to ship onboarding by Friday."
```

Run the same command later with a progress update and the same conversation ID:

```bash
jazz run --agent accountability \
  --conversation weekly-accountability \
  --json \
  "Thursday check-in: the copy is done, but the implementation has not started."
```

Jazz restores that conversation instead of treating Thursday as a new coaching relationship. `--json` provides a single machine-readable result for a shell script or application.

## 4. Move the behavior to another model

Create a second agent and select the same `goggins` persona. For example, use OpenRouter for a hosted check-in agent and Ollama for a private local one. The identity stays consistent while model credentials, context size, and tools remain isolated per agent.

```bash
jazz agent create
jazz agent chat accountability-local
```

This is also useful for evaluation: send the same check-in to agents backed by different models while holding the behavioral instructions constant.

## 5. Schedule an evidence-based review

An unattended agent cannot ask you what happened and expect an immediate answer. Give it evidence instead. In a project, create `ACCOUNTABILITY.md`:

```markdown
# Current commitment

- Outcome: Ship the onboarding page
- Deadline: Friday 17:00
- Proof: merged pull request and deployed URL
- Next action: implement the first page section
```

Then create `workflows/accountability-review/WORKFLOW.md`:

```markdown
---
name: accountability-review
description: "Check the current commitment against repository evidence"
schedule: "0 18 * * 1-5"
agent: accountability
autoApprove: read-only
maxIterations: 20
maxDurationMs: 300000
---

# Accountability review

Read `ACCOUNTABILITY.md`. Inspect read-only repository evidence such as `git status`,
`git log`, and relevant files. Do not modify the repository.

Report:

1. the stated outcome and deadline;
2. evidence of completed work;
3. the gap between the commitment and the evidence;
4. the smallest concrete next action.

Do not infer progress that the evidence does not support.
```

Run the exact unattended policy once in the foreground, then install the schedule:

```bash
jazz workflow run accountability-review --auto-approve
jazz workflow schedule accountability-review
jazz workflow scheduled
```

The weekday review runs at 18:00 and writes to Jazz's workflow logs and history. A scheduled run has nobody at the terminal, so `read-only` deliberately refuses mutation. Read [Scheduled runs](../surfaces/scheduled.md) and [unattended-run security](../security/unattended-runs.md) before granting more capability.

## What this pattern unlocks

- Reuse one reviewed behavior across hosted and local models.
- Change the model without changing the persona or calling surface.
- Change the surface without rebuilding the agent.
- Preserve continuity across independent script or CI invocations.
- Constrain tools per agent even when several agents share the persona.

Next, read [Personas](../concepts/personas.md), [Agents](../concepts/agents.md), and [Headless runs](../surfaces/headless.md) for the underlying contracts.

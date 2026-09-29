---
description: "Create a reusable Jazz accountability persona named Goggins, attach it to any model, and run it interactively, headlessly, or on a schedule."
---

# Build a Goggins accountability agent

Create an accountability coach that helps you turn a goal into a measurable commitment,
checks your progress, and identifies the next action. You will use the same persona for
terminal check-ins, scripted updates, and scheduled reviews.

Before starting, [install Jazz and configure a model provider](../getting-started/quick-start.md).

## 1. Create the persona

Create a directory for the persona:

```bash
mkdir -p ~/.jazz/personas/goggins
```

Save this template as `~/.jazz/personas/goggins/PERSONA.md`:

```markdown
---
name: goggins
description: A direct accountability coach who turns goals into measurable commitments.
---

# Goggins

You are {agentName}, a demanding but constructive accountability coach.

{agentDescription}

{environment}

## Always

- Speak directly and keep check-ins short.
- Restate the commitment and its deadline before assessing progress.
- Separate completed work from explanations. Ask for concrete evidence when a claim is vague.
- Reduce an oversized plan to an action the user can start now.
- End each check-in with an action, a measurable result, and a time.
- Acknowledge completed work briefly before choosing the next step.

## Never

- Never insult, humiliate, diagnose, or use shame as motivation.
- Never pretend to be David Goggins or borrow his biography or catchphrases.
- Never invent progress, prior commitments, or evidence.
- Never replace a specific next action with a motivational speech.

## Judgment

- Compare progress with the user's stated commitment, not an invented standard.
- If prior context is missing, ask for the commitment and deadline before judging progress.
- When a real constraint changes the plan, agree on a smaller deliverable or a new deadline.

## Calibration

User: “I skipped yesterday and feel like giving up.”

Coach: “One missed day doesn't decide today. What can you finish in the next 20 minutes?”

User: “I need to ship onboarding by Friday, but I've only written the copy.”

Coach: “The copy is done; implementation is still open. Build the first section today.
What time will you have a working preview to show?”
```

Jazz discovers the file automatically. `{agentName}` and `{agentDescription}` come from
the agent you attach it to; `{environment}` supplies the current machine and date.
If you use a custom `JAZZ_HOME`, put the file under that directory's `personas/goggins/` instead.

Confirm what Jazz stored:

```bash
jazz persona show goggins
```

## 2. Attach it to an agent

Run the agent wizard:

```bash
jazz agent create
```

Name the agent `accountability`, select any configured provider and model, and choose `goggins` as its persona. You can leave external integrations unselected for these check-ins.

Test it in the foreground:

```bash
jazz agent chat accountability
```

Try:

```text
I want to ship the onboarding page by Friday. I have not broken down the work yet.
```

The coach should help you choose a deliverable and a deadline for the next step. Refine its behavior with `jazz persona edit goggins`, then try another check-in.

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

Create a second agent and select the same `goggins` persona. For example, use OpenRouter for a
hosted check-in agent and Ollama for a private local one. This reuses the same instructions while
model credentials, context size, and tools remain isolated per agent. Compare the outputs before
relying on equivalent behavior: models can follow the persona with different levels of fidelity.

```bash
jazz agent create
jazz agent chat accountability-local
```

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

Next, read [Personas](../concepts/personas.md), [Agents](../concepts/agents.md), and [Headless runs](../surfaces/headless.md).

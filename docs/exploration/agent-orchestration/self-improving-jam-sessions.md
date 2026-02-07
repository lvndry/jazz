# Self-Improving Jam Sessions

> **Status:** Exploration
> **Audience:** Runtime, CLI, Tools, Memory workstreams

---

## Problem Statement

Jazz agents excel at single-run execution but lack a structured way to **practice**, **compare
techniques**, and **persist improvements**. Users currently depend on manual prompt edits and
intuition to make agents faster or safer. We want agents to:

1. Discover simpler workflows through repeated practice.
2. Share those workflows in a reviewable format.
3. Absorb validated improvements into their personal configuration.
4. Unlock new toolsets (“skills”) only after demonstrating competence.

## Outcome

Introduce a “Jam Session” outer loop where multiple agents tackle the same task template, publish
their transcripts, review peers, and automatically update their own skill notebooks. This produces
an evolving repository of best-known playbooks and measurable skill growth per agent.

---

## Solution Overview

| Layer                         | Responsibility                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Jam Session**               | Defines the shared objective, repo/context, scoring rules, and participating agents.                   |
| **Publication Ledger**        | Stores run transcripts, metrics, and peer reviews. Serves as the truth source for best solutions.      |
| **Skill Notebook**            | Per-agent writable prompt tail (or YAML) they self-edit through a gated tool to keep habits/reminders. |
| **Skill Capsules**            | Bundles of tools + prompt clauses that remain locked until the agent proves proficiency.               |
| **Simplicity Leaderboard**    | Automatically ranks submissions by measurable simplicity (tokens, approvals, wall-clock).              |
| **Practice Queue & Triggers** | Continuously feeds agents new practice runs targeting weak spots.                                      |
| **Prompt Regression Harness** | Replays canonical scenarios after every self-edit to prevent regressions.                              |

---

## Detailed Components

### 1. Jam Session Objects

- **Definition**: Structured metadata (YAML/JSON) describing goal, repo, workspace seed, evaluation
  hooks, and agent roster.
- **Storage**: `~/.jazz/sessions/<session-id>/session.json`. Include checksum + creation timestamp.
- **CLI**: `jazz session create`, `jazz session run`, `jazz session inspect`,
  `jazz session leaderboard`.
- **Runtime flow**:
  1. CLI loads session config, resolves referenced agents (IDs or templates).
  2. Spawns each agent via existing `AgentRunner.run` but injects session-specific system append
     (goal text, scoring hints).
  3. Collects structured outputs from `agent-run-metrics` for later scoring.

**Prerequisites**

- Extend Config service to locate session files (mirrors config resolution order).
- Ensure `AgentRunner` accepts `sessionContext` (goal metadata, evaluation hooks).

### 2. Publication Ledger & Reviews

- **Purpose**: Persist every practice run with metadata: agent, session, transcript digest, tool
  usage stats, approvals, runtime.
- **Storage**: Append-only sqlite database under `~/.jazz/sessions/jam-ledger.sqlite` (leveraging
  Drizzle or better-sqlite3 wrapper). Table sketch:
  - `submissions(id, session_id, agent_id, created_at, transcript_path, prompt_tokens, completion_tokens, approvals, duration_ms, score, status)`
  - `reviews(id, submission_id, reviewer_agent_id, verdict, notes, created_at)`
- **Workflow**:
  1. After each run, CLI writes transcript to `transcripts/<submission-id>.json`.
  2. Submission automatically enters `PENDING_REVIEW`.
  3. Other agents (or the same agent in a different slot) must submit review entries before new
     publications from them are accepted (configurable quota, e.g., 1 review => 1 publish).

**Implementation Tips**

- Hook into `finalizeAgentRun` to emit a machine-readable run summary.
- Provide CLI to `jazz session review <submission-id> --agent <agent>` which loads transcript
  context and opens a chat where the agent produces review text.

### 3. Self-Edit Skill Notebook Tool

- **Goal**: Give agents a first-class tool to evolve their personal instructions safely.
- **Design**:
  - Notebook stored at `~/.jazz/agents/<agent-id>/skill-notebook.md`.
  - Expose two tools via Tool Registry: `skill_notebook_append`, `skill_notebook_edit` (mirrors
    existing `append`/`edit` semantics from other systems but scoped to Jazz).
  - Tool execution pipeline writes new notebook version + logs change in ledger.
- **Safety**:
  - Every notebook edit triggers the regression harness (see component 7).
  - Require human approval or auto-approval based on risk level (if change < N chars?).

### 4. Skill Capsules & Unlock Criteria

- **Concept**: Each capsule bundles:
  - Tool names (e.g., `git_push`, `exec_command`).
  - Prompt clauses describing how/when to use them.
  - Unlock rule referencing ledger metrics (e.g., “two passing submissions in session class
    `git_cleanup` with <2 approvals”).
- **Implementation**:
  - Define capsule manifests in `docs/skills/capsules/*.json` and load via Config service.
  - Extend agent config to list enrolled capsules. Locked capsules expose “virtual” tools that throw
    instructive errors until unlocked.
  - Add CLI `jazz agent skills <agent-id>` to inspect status.

### 5. Simplicity Leaderboard

- **Metric schema**:
  - `simplicity_score = w1 * approvals + w2 * duration + w3 * tool_invocations + w4 * token_sum`
    (weights configurable).
  - Additional badges for “no approvals required”, “single tool use”, etc.
- **Surfacing**: `jazz session leaderboard <session-id>` prints top N submissions plus deltas.
- **Automation**: When a new submission beats the current champion's score, mark it as
  `CURRENT_BEST`. Agents can challenge by referencing the champion ID in their run metadata.

### 6. Practice Queue & Trigger Integration

- **Sources**:
  - Scheduled triggers (cron-style) feed new runs.
  - Event triggers (e.g., detection of repeated approvals) enqueue targeted sessions.
- **Mechanics**:
  - Persist queue entries in sqlite with `status = QUEUED/RUNNING/FAILED`.
  - CLI subcommand `jazz practice worker` polls queue and launches headless runs.
  - Use existing TODO item “Trigger system (schedule, file, webhook, manual)” as backbone.

### 7. Prompt Regression Harness

- **Purpose**: Protect against regressions when agents self-edit notebooks or unlock capsules.
- **Implementation**:
  - Maintain a library of canonical tasks per skill (JSON instruction + workspace fixture).
  - After a notebook change, automatically replay these tasks in dry-run mode using
    `AgentRunner.run` with `maxIterations` set low.
  - Compare outputs against stored golden metrics; if degraded, revert notebook (commit-style
    rollback) and log failure.

---

## Implementation Plan (Phased)

### Phase 0 — Instrumentation Prep

1. Expand `agent-run-metrics` to emit a normalized summary object (JSON) per run.
2. Ensure `LoggerService` exposes hooks for CLI consumers to capture transcripts programmatically.
3. Add config toggles for experimental features under `appConfig.experimental`.

**Prereqs**: None beyond current runtime.

### Phase 1 — Sessions & Ledger MVP

1. Implement session file schema + CLI plumbing.
2. Build sqlite-backed ledger with migrations.
3. Modify CLI run path (`jazz agent chat/run`) to optionally attach to a session.
4. Store transcripts + metrics in ledger.

**Dependencies**: Config service updates, fs helpers.

### Phase 2 — Reviews & Leaderboard

1. Add review CLI + enforcement of “review before publish” quotas.
2. Implement scoring pipeline + leaderboard CLI view.
3. Provide human-readable diffs for reviewers (reuse Markdown renderer).

**Dependencies**: Phase 1 ledger, scoring heuristics.

### Phase 3 — Skill Notebooks & Regression Harness

1. Introduce notebook storage + Tool Registry entries.
2. Build regression harness runner and revert logic.
3. Wire approvals for notebook edits (reusing existing approval workflow).

**Dependencies**: Phase 0 instrumentation, Phase 1 run summaries.

### Phase 4 — Skill Capsules & Practice Queue

1. Define capsule manifests and gating logic in Tool Registry.
2. Extend CLI to inspect/apply capsules.
3. Create practice queue schema + worker loop, integrate with triggers.

**Dependencies**: Notebook (for injecting prompt clauses), ledger metrics (unlock rules).

### Phase 5 — Automation Polish

1. Add `jazz session jam` to spawn multiple agents concurrently (leveraging existing CLI concurrency
   helpers).
2. Implement auto-challenge notifications when a new best submission lands.
3. Add metrics dashboards (reuse existing logging hooks) for aggregated practice stats.

---

## Risks & Mitigations

| Risk                                            | Impact                 | Mitigation                                                                        |
| ----------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| Ledger corruption or bloat                      | Loss of history        | Versioned migrations, backup/export CLI, size limits per transcript               |
| Agents spamming low-quality submissions         | Review fatigue         | Enforce “review quota” and automatic scoring thresholds before publication        |
| Self-edit tool causing regressions              | Broken agents          | Regression harness + automatic rollback + alerting                                |
| Capsule unlock deadlock (no one meets criteria) | Features remain locked | Allow admins to grant override tokens, or implement collaborative unlock missions |
| User experience complexity                      | Onboarding friction    | Ship default session templates + guided `jazz session init --preset git-cleanup`  |

---

## Open Questions

1. How do we surface ledger data in the TUI without overwhelming users? (Maybe optional `--insights`
   flag.)
2. Should reviews be fully automated (agents reviewing agents) or require human approval for final
   acceptance?
3. What is the right persistence layer? (Leaning sqlite for simplicity, but could reuse Effect-TS
   friendly stores.)
4. How do we share session templates across teams? (Possibly via npm package or Git repo.)
5. Can capsule unlocks feed into pricing (e.g., higher capability agents cost more tokens)?

---

## Notes

- Inspiration: lessons learned from publication-driven multi-agent systems such as **srchd**, which
  demonstrated the value of peer review loops and self-editing prompts for scaling coordinated
  research.

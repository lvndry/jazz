# Jazz Differentiation Thesis: Capability OS + Terminal Workstation

## Why this doc exists
Jazz risks drifting into “a smaller OpenClaw” if its identity becomes “an assistant that can do things.”

This document proposes a durable differentiation:

- **Jazz is not an always-on personal assistant.**
- **Jazz is a terminal-native automation workstation** built on a **capability-secure runtime**.

In short: **make powerful automation safe, inspectable, and ergonomic for people who do real work in the terminal.**

---

## Competitive reality (what OpenClaw optimizes for)
OpenClaw’s center of gravity is distribution + presence:

- Always-on gateway/daemon
- Multi-channel interfaces (Slack/Discord/WhatsApp/etc.)
- Voice/camera/transcription
- Canvas/UI surfaces

Those are legitimate moats, but they are *product-surface moats*.

Jazz should not try to win by cloning those surfaces.

---

## Jazz’s long-term identity
### Thesis
**Jazz is a Capability OS for automation with a best-in-class terminal UI.**

- *Capability OS* means: actions are gated by **runtime-enforced capabilities** (security by construction), not just “please approve this tool call.”
- *Terminal workstation* means: the primary interface is an **interactive TUI** for planning, reviewing, and applying changes.

### Target user
- Engineers, toolsmiths, and operators
- Anyone running automations that touch:
  - codebases (large refactors)
  - shells (dangerous commands)
  - secrets (tokens/keys)
  - deployments/releases

### Outcome
Jazz becomes the place you go when the automation is powerful enough to be scary.

---

## Non-goals (anti-drift)
To avoid becoming “baby OpenClaw,” Jazz should explicitly *not* lead with:

1. **Always-on daemon as the core product**
2. **"Message me anywhere" channel strategy**
3. **Voice assistant features**
4. **Companion apps as the primary moat**

Channels can exist later as *thin adapters*, but they must not define Jazz.

---

## The moat: Capabilities (security by construction)
### The problem with “approvals only”
A pure yes/no approval queue is reactive and brittle:

- The agent can propose dangerous actions repeatedly.
- Approvals become noisy.
- Users habituate (“click yes”) under time pressure.

### Capability model
In Jazz, the agent only receives the tools/permissions it is allowed to use.
If a capability isn’t granted, the action is impossible.

Capabilities should be:
- **Fine-grained** (path-, repo-, host-, domain-scoped)
- **Composable** (profiles for common tasks)
- **Budgeted** (limits on count/time/bytes)
- **Expiring** (TTL)
- **Auditable** (who/what/why)

#### Examples
**Filesystem**
- `fs.read(/repo/**)`
- `fs.write(/repo/src/**)`
- `fs.delete(none)`

**Shell**
- Allow only specific binaries and argument patterns
- Optionally require sandboxing / working-dir constraints

**Git**
- Allow `status/diff/commit`
- Deny `push` unless explicitly granted: `git.push(remote=origin, branch=main)`

**Network**
- Default: none
- Allowlist domains (e.g., `api.github.com`), block exfil paths by default

**Secrets**
- Secrets are scoped objects the runtime can pass to tools
- Prevent secrets from being printed/logged by design (redaction + policy)

### Capability approval ≠ tool-call approval
Approval becomes:
- “Grant `fs.write(/repo/src/**)` for 10 minutes, max 50 edits”

Not:
- “Approve this exact write call #37”

This reduces fatigue and increases real safety.

---

## The other moat: Terminal-native workstation UX
OpenClaw optimizes for chat/canvas surfaces.
Jazz should optimize for **doing work with confidence**.

### Must-have TUI features
1. **Plan view**
   - A structured preview of intended actions (tree/DAG)
   - Risk annotations (writes, deletes, network, secrets)

2. **Inline diffs + hunk controls**
   - Review/accept/reject changes like `git add -p`, but for agent edits

3. **Scoped grants UI**
   - Edit capability scopes interactively (paths, TTL, budgets)

4. **Run timeline (“time-travel trace”)**
   - Every tool call with inputs/outputs and the reason it happened

5. **Checkpointing + reruns**
   - Resume from a step after adjusting instructions

The TUI is where Jazz becomes a product, not a library.

---

## North Star demo (keeps the roadmap honest)
### “Safe refactor across 30 repos”
A single Jazz session can:

1. Scan multiple repos
2. Propose a plan per repo
3. Show diffs in a TUI
4. Grant capabilities only for `src/**` writes; block network
5. Apply changes with checkpoints
6. Emit artifacts + rollback guidance

This is difficult to replicate with a channel-first assistant.

---

## Roadmap (opinionated)
### Phase 1 — Capabilities MVP
- Capability schema and enforcement (deny-by-default for dangerous ops)
- Profiles (e.g., `refactor-safe`, `repo-audit`, `release`) with override support
- Scoped grants with TTL + budgets
- Audit log for grants + execution

**Success criterion:** A user can safely allow a high-volume refactor without approving every tool call.

### Phase 2 — Workstation MVP (TUI)
- Plan preview
- Inline diff review with accept/reject
- Trace viewer
- “apply selected changes” flow

**Success criterion:** Jazz feels faster and safer than manual scripting for large code changes.

### Phase 3 — Run artifacts + replay (AgentOps-lite)
- Persist run artifacts (with redaction)
- Record/replay tool calls for debugging
- CI mode: validate policy compliance + expected diff outputs

**Success criterion:** You can debug or regression-test workflows like software.

---

## Product messaging (how we talk about Jazz)
Avoid:
- “Your personal assistant”
- “Chat with tools”
- “Bots everywhere”

Prefer:
- “**Capability-secure automation** in the terminal.”
- “**Inspect, grant, and apply** powerful automations safely.”
- “A workstation for agent-driven refactors, releases, and runbooks.”

---

## Open questions (to decide early)
To make the capability system real, Jazz should pick the #1 “scary action” to optimize for first:

- mass code edits/refactors
- shell command execution
- secrets usage
- git pushing/releases
- infra changes

Choosing one will drive the first capability profiles and the TUI review flow.

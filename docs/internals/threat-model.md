# Threat model

**Status: draft — v1 to be dated and published. Items marked ☐ are self-audit checks still
to be run before any public safety claim.**

Jazz's safety stance is *fail closed by construction*: when the agent, the classifier, or
the operator hasn't explicitly widened what may run, the answer is "ask a human." This
document lists what that means concretely, what it does **not** protect against, and how to
check both.

---

## What runs without asking

One dial — the approval policy — governs every surface the same way (terminal, CI, bots):

| Policy      | Auto-approves                                       |
| ----------- | --------------------------------------------------- |
| `false`     | Nothing. Every gated tool asks.                     |
| `read-only` | Reading files, search, web requests                 |
| `low-risk`  | + todo tracking, reminders, spawning sub-agents     |
| `high-risk` | + file changes, shell commands, git commit and push |

Everything above the dial blocks and emits `approval_required`; the run resumes only when
an `approval_decision` comes back — from the terminal, or from your phone via a chat
bridge. An unattended run that hits its ceiling waits; it does not die and it does not
proceed. Source: [tools-and-approval](./tools-and-approval.md).

Two sharper controls sit under the dial:

- **Toolset omission.** An agent's tool list is explicit; a tool not listed does not exist
  for that agent. An agent without `execute_command` cannot run shell commands regardless
  of policy. This is the strongest control and the recommended one for anything unattended.
- **`autoApprovedCommands`.** A persisted allowlist that admits single commands without
  raising the whole tier. Matching is a parsed key (binary + first subcommand) with
  word-boundary comparison — `git status` does not also permit
  `git status && rm -rf /`. Source: `src/core/agent/tools/command-risk.ts`,
  [configuration](../reference/configuration.md).

## Shell commands fail closed

Commands with no static risk annotation are classified before approval. The classifier's
instruction is explicit: *"high-risk = anything else, including uncertainty"* and *"a
clearly mutating command is high-risk even if the conversation asked for something
milder."* Text inside the command is treated as data to classify, never as instructions.
An ambiguous command on an unattended run therefore blocks rather than runs.
Source: `src/core/agent/tools/command-risk.ts`.

## Where secrets live

- **API keys** are stored in the OS keyring, not in config files
  (`src/services/secrets/keyring.ts`; `JAZZ_DISABLE_KEYRING` opts out).
- **Child processes are scrubbed.** Any environment variable whose name matches
  `API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` is stripped before a shell command or
  custom command tool spawns. Exceptions require an explicit per-agent `envAllowlist`
  entry; `SSH_*` names can never be allowlisted. Source:
  [configuration → envAllowlist](../reference/configuration.md).
- **Known weakness, stated plainly:** conversation transcripts are plaintext JSON under
  `~/.jazz/history/`. Treat that directory as sensitive. Anything the agent read during a
  run may be in there.

## Network posture

- The CLI opens **no listening port**. `jazz run` is a process that starts, works, and
  exits.
- The Telegram bridge defaults to **long-polling** (`getUpdates`): outbound connections
  only, no public URL, works behind NAT. Webhook mode exists but is opt-in and requires a
  secret. One caveat stated honestly: the bridge container always runs a minimal `/health`
  HTTP endpoint for container health checks. Source: `integrations/telegram-bot/bridge.ts`.
- `JAZZ_OFFLINE=1` stops every outbound request Jazz makes on its own behalf except model
  inference itself. Source: [airgapped](../guide/airgapped.md).

## Runaway protection

Unattended runs are budgeted, not trusted: an iteration ceiling with escalating wrap-up
pressure, loop detection keyed on tool-name *plus arguments*, context compaction, and cost
reported on every run. Source: [agent-loop](./agent-loop.md).

## What Jazz does NOT protect against

Claiming less is part of the model. Jazz does not currently defend against:

- **Prompt injection steering permitted actions.** Content the agent reads (a web page, an
  email, a PR body) can influence what it does *within* its approved tier. The mitigations
  are structural — narrow toolsets, low tiers for unattended runs, approval walls for
  everything mutating — not content analysis.
- **A hostile deployment operator.** `customTools` command handlers run what the
  deployment configured; they are deployment-authored trust, always registered high-risk.
- **A compromised model provider.** Inference traffic goes to whichever provider you
  configured. Local models via `ollama` remove that dependency.

## Self-audit checklist (run before every public safety claim)

Failure classes below are the ones that burned other agent deployments in 2026. Each gets
re-checked, on the released binary, before we say the word "safe" anywhere:

- ☐ Fresh install: no plaintext key written anywhere under `~/.jazz` when the keyring is
  available.
- ☐ Bridge `.env` handling: bot token never logged, never echoed into transcripts.
- ☐ Default agent toolset after the wizard: confirm `execute_command` posture and that the
  default approval policy asks before mutations.
- ☐ `read-only` tier semantics: enumerate exactly which outbound requests it permits, and
  document that list.
- ☐ Port scan of a default `docker compose up` bridge: nothing listening except `/health`.
- ☐ `jazz bench safety` tripwire suite passes 10/10 on the release candidate (planned —
  see the eval harness).
- ☐ Webhook mode: secret required, requests without it rejected.

## Reporting

Vulnerabilities: see [SECURITY.md](../../SECURITY.md). Reports that demonstrate any checked
item above failing are treated as release blockers, not enhancements.

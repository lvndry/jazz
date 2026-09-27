---
name: install-jazz-github-action
description: Set up Jazz as a GitHub Action for automated PR code review and on-demand /jazz PR assistance. Use when the user asks to add Jazz to CI, create a GitHub Action workflow, set up PR review automation, enable /jazz commands on PRs, or integrate Jazz with GitHub.
---

# Create Jazz GitHub Action

Turn Jazz into a GitHub Actions-powered PR reviewer and on-demand assistant. When someone opens a PR or comments `/jazz`, a Jazz agent reviews the diff and posts inline comments or answers questions.

## Architecture

The setup uses five files in your repo plus one model-provider secret:

```
.github/
├── workflows/
│   └── jazz.yml              # Driver workflow (3 jobs: resolve, code-review, assistant)
└── jazz/
    ├── agents/
    │   ├── ci-reviewer.json   # Code review agent config
    │   └── pr-assistant.json  # PR assistant agent config
    └── workflows/
        ├── code-review/
        │   └── WORKFLOW.md    # Review instructions
        └── pr-assistant/
            └── WORKFLOW.md    # Assistant instructions
```

> The `release-notes` agent + WORKFLOW.md in `.github/jazz/` are not wired into `jazz.yml`; they are a manual utility and are intentionally absent from CI.

**Required secret:** a model-provider API key for the model chosen in step 1 (e.g. `OPENAI_API_KEY` if the user picked OpenAI). You must add it as a GitHub Actions secret — see step 5.

### Workflow Jobs

The `jazz.yml` workflow has three jobs:

| Job           | Trigger                                                                                                     | What it does                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `resolve`     | Always runs first                                                                                           | Extracts PR number, base SHA, head SHA, and user request from the triggering event |
| `code-review` | PR opened/marked ready, `/jazz-review` comment, workflow_dispatch, or a push that changes `jazz.yml` itself | Checks out code, runs Jazz review agent, parses output, posts inline comments      |
| `assistant`   | `/jazz <question>` comment, bare `/jazz`, workflow_dispatch, or a push that changes `jazz.yml` itself       | Checks out code, runs Jazz assistant agent, posts answer as a PR comment           |

> The `assistant` job depends only on `resolve`; the workflow's `concurrency` group serializes runs on the same PR so the two Jazz jobs don't burst the same provider account at once. A push to a branch with an open PR re-runs both jobs end-to-end to validate a change to `jazz.yml` itself.

### Authorization

Only PRs from the same repository (not forks) trigger Jazz jobs, and only users with OWNER/MEMBER/COLLABORATOR association can invoke `/jazz` or `/jazz-review`. This is enforced via `if:` conditions in the workflow.

### Security Model

The PR diff, title, body and comments are untrusted input to an agent with shell access, so the template keeps that agent's reach small:

- **No token for the agent.** Checkouts use `persist-credentials: false`, so `GITHUB_TOKEN` is not left in `.git/config`. PR context is pre-fetched by a snapshot step (the only step besides the posting steps with `GH_TOKEN`) and written to `/tmp/jazz-pr-context.json`. All posting back to GitHub is done by `actions/github-script` steps after the agent finishes.
- **Only trusted comments.** The snapshot's `jq` filter keeps comments, reviews and inline review comments from `OWNER`, `MEMBER` and `COLLABORATOR` authors plus the `github-actions` bot (the workflow's own earlier reviews). Anyone can comment on a public PR; everything else is dropped.
- **Read-only policy.** Both workflows set `autoApprove: read-only`: every shell command goes through Jazz's command classifier and runs only if it is classified read-only, which covers the `git diff`/`git log` reads the agents need. The agents have no `http_request` and no file-writing tools.
- **Bounded runs.** Every job has `timeout-minutes`, and each run passes `--max-cost-usd "$JAZZ_MAX_COST_USD"` (set once at the top of `jazz.yml`).

## Setup

### 1. Ask which model/provider (do this first)

Before writing any files, ask the user which model they want the agents to run on. Use `ask_user_question` (or a plain question) to confirm:

- **Provider**: OpenAI, OpenRouter, or another provider Jazz supports
- **Model**: e.g. `gpt-5.4-mini` (OpenAI) or whatever the provider exposes
- **Secret name**: the API key that goes with it (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, etc.)

Record the chosen `llmProvider` + `llmModel` and the secret name — every later step uses them. Don't assume a provider; the user may prefer OpenRouter or another. If they have no preference, suggest OpenAI `gpt-5.4-mini` as a sensible default but still confirm. The agent configs in this repo (step 3) are **examples to adapt**, not a verbatim copy.

### 2. Create the driver workflow

`.github/workflows/jazz.yml` — see the [full reference implementation](https://github.com/lvndry/jazz/blob/main/.github/workflows/jazz.yml).

The key design:

- **`resolve` job** uses `actions/github-script` to extract PR context from `pull_request`, `issue_comment`, `push`, or `workflow_dispatch` events, and reacts with 👀 on triggering comments
- **`code-review` job** checks out PR head with `persist-credentials: false`, installs `jazz-ai` (`bun install -g jazz-ai --trust`), copies agent config + workflow file into `$HOME/.jazz/agents/` and `workflows/code-review/` with placeholder substitution, snapshots trusted PR context, runs `jazz workflow run code-review --auto-approve --agent ci-reviewer --max-cost-usd "$JAZZ_MAX_COST_USD" --json`, then posts results
- **`assistant` job** same structure, runs `jazz workflow run pr-assistant --auto-approve --agent pr-assistant --max-cost-usd "$JAZZ_MAX_COST_USD" --json`, posts a PR comment

`--json` is required: stdout carries exactly one JSON envelope (`{"ok":true,"answer":…}` or `{"ok":false,"error":…}`) that the run step reads with `jq`. When a run fails, the posted comment and the job summary name the cause (for example "Review skipped: provider authentication failed.") instead of reporting an unparseable verdict.

`--trust` is required on the install step: `bun install -g` runs with lifecycle scripts (postinstall) blocked by default, and `jazz-ai`'s postinstall is what actually installs the `jazz` binary. Without `--trust`, the install "succeeds" but no binary lands, and every later `jazz` invocation in the workflow fails with `jazz: command not found`. CI runners are ephemeral, so there's no persistent trust state to set up (unlike `bun pm trust` on a dev machine) — pass `--trust` on every run.

### 2. Create agent configs

`.github/jazz/agents/ci-reviewer.json`:

```json
{
  "id": "ci-reviewer",
  "name": "ci-reviewer",
  "description": "Adversarial CI review board lead — spawns specialist sub-agents and cross-examines their findings",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-5.4-mini",
    "reasoning": "medium",
    "tools": [
      "context_info",
      "find",
      "execute_command",
      "grep",
      "ls",
      "read_file",
      "spawn_subagent",
      "summarize_context"
    ]
  }
}
```

`.github/jazz/agents/pr-assistant.json`:

```json
{
  "id": "pr-assistant",
  "name": "pr-assistant",
  "description": "Pull request assistant agent for /jazz PR comments",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-5.4-mini",
    "reasoning": "medium",
    "tools": [
      "context_info",
      "find",
      "execute_command",
      "grep",
      "ls",
      "read_file",
      "spawn_subagent",
      "summarize_context"
    ]
  }
}
```

The config has no top-level `model` field: the model is set entirely inside `config` via `llmProvider` and `llmModel`. Neither agent gets `write_file`, `edit_file` or `http_request`: both only read the checkout, and the posting steps own every write to GitHub.

### 3. Create workflow instructions

`.github/jazz/workflows/code-review/WORKFLOW.md` — instructs the agent to:

- Read PR context from `/tmp/jazz-pr-context.json`
- Run `execute_command` with `git diff __PR_BASE_SHA__...__PR_HEAD_SHA__`
- Assemble a board of `spawn_subagent` lenses (Correctness, Architecture, Silent Failures, Security, Performance, Test Rigor, and diff-scoped lenses) and cross-examine findings
- Output exactly two four-backtick fenced blocks: `markdown` verdict then `json` inline comments

See the [reference WORKFLOW.md](https://github.com/lvndry/jazz/blob/main/.github/jazz/workflows/code-review/WORKFLOW.md) for the full review board protocol.

`.github/jazz/workflows/pr-assistant/WORKFLOW.md` — instructs the agent to:

- Read PR context and the user's request
- Inspect the diff and surrounding code (spawning sub-agents for large PRs)
- Answer in a single four-backtick `markdown` fenced block
- Never output JSON (the assistant writes prose for humans)

Placeholders are substituted by the CI setup step before the run. The `code-review` template uses `__PR_BASE_SHA__`, `__PR_HEAD_SHA__`, and `__WORKSPACE__`; the `pr-assistant` template additionally uses `__PR_NUMBER__`, `__REQUEST__`, and `__REPO__`. Only the placeholders a given template references are replaced, so keep template and substitution in sync.

Each `WORKFLOW.md` also carries YAML frontmatter. Start both from this policy:

```yaml
autoApprove: read-only
agent: ci-reviewer
maxIterations: 50
```

`--auto-approve` tells `jazz workflow run` to apply this frontmatter policy instead of prompting; there is no person on a runner. Keep the policy at `read-only`: a PR author or commenter who can steer the agent should not be able to make it write files or run arbitrary shell.

### 4. Configure secrets

You **must** add a model-provider API key as a GitHub Actions secret, or the workflow fails at the `Run code review` / `Run Jazz assistant` step (the agent has no key to call the model).

1. In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
2. Add the key for the provider your agents actually use:
   - `<PROVIDER>_API_KEY` — the variable name for the provider your agents name:
     `OPENAI_API_KEY` for the bundled configs (`config.llmProvider: openai`),
     `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, and so on
3. **Use any model/provider you like.** Edit `config.llmProvider` and `config.llmModel` in `.github/jazz/agents/*.json`, then add the corresponding key. The workflow reads whichever key is set; only one is required.

`GITHUB_TOKEN` is provided automatically — you don't create it.

## The `/jazz` and `/jazz-review` Protocol

### Comment commands

| Comment            | Effect                                                                                                           | Authorization             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/jazz-review`     | Triggers a full code review with inline comments (the `code-review` job)                                         | OWNER/MEMBER/COLLABORATOR |
| `/jazz <question>` | Runs the PR assistant to answer a question (the `assistant` job)                                                 | OWNER/MEMBER/COLLABORATOR |
| `/jazz` (bare)     | Routes to the assistant job with the default request "Review this pull request and call out anything important." | OWNER/MEMBER/COLLABORATOR |

> `/jazz-review` (hyphen) is the inline reviewer. `/jazz review` (space) is **not** the same — the space form routes to the conversational assistant. The `resolve` step strips the `/jazz` prefix and forwards everything after it as the assistant's request.

### Output contracts

**Code-review agent** output contract:

`````
```markdown
Reviewed 4 files. Found 2 issues.
```

````json
[
  {
    "path": "src/example.ts",
    "line": 42,
    "side": "RIGHT",
    "body": "**Critical**: This crashes when `user` is null.\n\nFix: add null guard."
  }
]
````
`````

- Block 1: Four-backtick `markdown` — non-empty review verdict
- Block 2: Four-backtick `json` — array of inline comments (may be `[]`)
- Comments have `path`, `line`, `start_line` (optional), `side` (`RIGHT`/`LEFT`), `body`
- Outer fences use four backticks so inner code snippets (three backticks) don't collide

**PR assistant** output contract:

````markdown
### Summary

This PR refactors the connection pool...

```diff
- old code
+ new code
```
````

- Single four-backtick `markdown` block
- Prose markdown for humans — no JSON, no structured output
- Inner code fences use three backticks

## Inline Comment Validation

The posting step validates every inline comment against actual diff hunks before calling the GitHub API. Comments referencing lines outside the diff are rolled into the review body as general comments instead of being rejected.

Validation logic (in the `actions/github-script` posting step):

1. Fetch PR files with `pulls.listFiles` to get the unified diff
2. Parse hunk headers (`@@ -old +new @@`) to build a set of valid left/right line numbers per file
3. Check each comment's `line` (and `start_line` if present) exists in the appropriate side's set
4. Comments passing validation → posted as inline review comments
5. Comments failing validation → appended to review body as general comments

When a run fails, the posting step comments the cause ("Review skipped: provider authentication failed.") and writes it to the job summary. A rate limit or timeout only warns, so a throttled free tier does not paint CI red; anything else (a rejected API key, a missing secret) fails the job so it gets fixed.

## Common Customizations

- **Different model**: Change `config.llmProvider` and `config.llmModel` in the agent JSON, and add the matching provider key as a secret
- **Stricter/looser review**: Edit the code-review WORKFLOW.md's board lenses and verdict bar
- **Add a custom agent**: Create a new agent JSON + WORKFLOW.md + workflow job
- **Fork PRs**: Remove the `head.repo.full_name == github.repository` guard if you trust fork PRs (not recommended — a fork's `GITHUB_TOKEN` can't reach your secrets)

## Troubleshooting

| Symptom                                          | Likely cause                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Workflow skips jobs                              | Fork PR (`head.repo.full_name` mismatch)                           |
| `/jazz` comment ignored                          | Comment author not OWNER/MEMBER/COLLABORATOR                       |
| "Review skipped: provider authentication failed" | The `<PROVIDER>_API_KEY` secret is wrong or revoked                |
| Agent output not posted                          | Output didn't match contract (check workflow run logs)             |
| `jazz: command not found`                        | `bun install -g jazz-ai --trust` failed, or runner lacks Bun       |
| Inline comments rejected                         | Lines reference outside diff hunks (falls back to general comment) |
| "No issues found" on every PR                    | Model too weak or workflow prompt lacks specificity                |

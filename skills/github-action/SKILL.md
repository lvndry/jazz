---
name: github-action
description: Set up Jazz as a GitHub Action for automated PR code review and on-demand /jazz PR assistance. Use when the user asks to add Jazz to CI, create a GitHub Action workflow, set up PR review automation, enable /jazz commands on PRs, or integrate Jazz with GitHub. Triggers on "github action", "github actions", "ci", "pr review", "pr assistant", "jazz in ci", "/jazz".
tagline: Run Jazz agents as a GitHub Action — automated PR review and on-demand /jazz PR assistant.
triggers:
  - github action
  - github actions
  - ci pipeline
  - pr review
  - pr assistant
  - jazz in ci
  - /jazz
---

# GitHub Action

Turn Jazz into a GitHub Actions-powered PR reviewer and on-demand assistant. When someone opens a PR or comments `/jazz`, a Jazz agent reviews the diff and posts inline comments or answers questions.

## Architecture

The setup uses five files in your repo plus two secrets:

```
.github/
├── workflows/
│   └── jazz.yml              # Driver workflow (3 jobs)
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

**Required secrets:** `OPENAI_API_KEY` (or `OPENROUTER_API_KEY`).

### Workflow Jobs

The `jazz.yml` workflow has three jobs:

| Job | Trigger | What it does |
|-----|---------|-------------|
| `resolve` | Always runs first | Extracts PR number, base SHA, head SHA, and user request from the triggering event |
| `code-review` | PR opened, `/jazz-review` comment, workflow_dispatch | Checks out code, runs Jazz review agent, parses output, posts inline comments |
| `assistant` | `/jazz <question>` comment, workflow_dispatch | Checks out code, runs Jazz assistant agent, posts answer as PR comment |

### Authorization

Only PRs from the same repository (not forks) trigger Jazz jobs, and only users with OWNER/MEMBER/COLLABORATOR association can invoke `/jazz` or `/jazz-review`. This is enforced via `if:` conditions in the workflow.

### Security Model

The Jazz agent **never receives `GITHUB_TOKEN`**. PR context (title, body, labels, comments, reviews) is pre-fetched by a step with `GH_TOKEN` and written to `/tmp/jazz-pr-context.json`. The agent reads this static file. All posting back to GitHub is done by `actions/github-script@v7` steps after the agent finishes.

## Setup

### 1. Create the driver workflow

`.github/workflows/jazz.yml` — see the [full reference implementation](https://github.com/jazz-ai/jazz/blob/main/.github/workflows/jazz.yml).

The key design:
- **`resolve` job** uses `actions/github-script@v7` to extract PR context from `pull_request`, `issue_comment`, `push`, or `workflow_dispatch` events
- **`code-review` job** checks out PR head, installs `jazz-ai`, copies agent config + workflow files into `$HOME/.jazz/` and `./workflows/` with placeholder substitution, snapshots PR context, runs `jazz workflow run code-review --auto-approve --agent ci-reviewer`, then posts results
- **`assistant` job** same structure, runs `jazz workflow run pr-assistant --auto-approve --agent pr-assistant`, posts a PR comment

### 2. Create agent configs

`.github/jazz/agents/ci-reviewer.json`:
```json
{
  "id": "ci-reviewer",
  "name": "ci-reviewer",
  "description": "CI code review agent focused on intent, behavior, and risk",
  "model": "openai/gpt-4o-mini",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-4o-mini",
    "reasoningEffort": "high",
    "tools": [
      "context_info", "find", "git_diff", "git_log", "grep",
      "http_request", "ls", "read_file", "summarize_context", "write_file"
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
  "model": "openai/gpt-4o-mini",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-4o-mini",
    "reasoningEffort": "medium",
    "tools": [
      "context_info", "find", "git_diff", "git_log", "git_tag_list",
      "grep", "http_request", "ls", "read_file", "summarize_context"
    ]
  }
}
```

### 3. Create workflow instructions

`.github/jazz/workflows/code-review/WORKFLOW.md` — instructs the agent to:
- Read PR context from `/tmp/jazz-pr-context.json`
- Run `git_diff` with `commit: "__PR_BASE_SHA__...__PR_HEAD_SHA__"`
- Review for correctness, security, and maintainability
- Use `spawn_subagent` for large PRs (10+ files or 500+ lines)
- Output exactly two four-backtick fenced blocks: `markdown` verdict then `json` inline comments

See the [reference WORKFLOW.md](https://github.com/jazz-ai/jazz/blob/main/.github/jazz/workflows/code-review/WORKFLOW.md) for the full review checklist.

`.github/jazz/workflows/pr-assistant/WORKFLOW.md` — instructs the agent to:
- Read PR context and the user's request
- Inspect the diff and surrounding code
- Answer in a single four-backtick `markdown` fenced block
- Never output JSON (the assistant writes prose for humans)

Placeholders in these files (`__PR_NUMBER__`, `__PR_BASE_SHA__`, `__PR_HEAD_SHA__`, `__REQUEST__`, `__REPO__`, `__WORKSPACE__`) are substituted by the CI setup step.

### 4. Configure secrets

Add to your GitHub repo or org secrets:
- `OPENAI_API_KEY` — OpenAI API key (for gpt-4o-mini or similar)
- or `OPENROUTER_API_KEY` — OpenRouter API key (for broader model selection)

## The `/jazz` and `/jazz-review` Protocol

### Comment commands

| Comment | Effect | Authorization |
|---------|--------|---------------|
| `/jazz-review` | Triggers a full code review with inline comments | OWNER/MEMBER/COLLABORATOR |
| `/jazz <question>` | Runs the PR assistant to answer a question | OWNER/MEMBER/COLLABORATOR |
| `/jazz` (bare) | Default: "Review this PR and call out anything important" | OWNER/MEMBER/COLLABORATOR |

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

## Common Customizations

- **Different model**: Change `model`, `llmProvider`, `llmModel` in the agent JSON
- **Stricter/looser review**: Edit the code-review WORKFLOW.md tone and checklist sections
- **Add a custom agent**: Create a new agent JSON + WORKFLOW.md + workflow job
- **Fork PRs**: Remove the `head.repo.full_name == github.repository` guard if you trust fork PRs (not recommended)

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| Workflow skips jobs | Fork PR (`head.repo.full_name` mismatch) |
| `/jazz` comment ignored | Comment author not OWNER/MEMBER/COLLABORATOR |
| Agent output not posted | Output didn't match contract (check workflow run logs) |
| `jazz: command not found` | `bun add -g jazz-ai` or `npm install -g jazz-ai` failed, or runner lacks Bun/Node |
| Inline comments rejected | Lines reference outside diff hunks (falls back to general comment) |
| "No issues found" on every PR | Model too weak or workflow prompt lacks specificity |

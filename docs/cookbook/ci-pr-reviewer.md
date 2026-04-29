# ci-pr-reviewer

**What it does:** On every opened PR (or on `/jazz-review` comment from a trusted user), runs a Jazz agent that reviews the diff and posts inline review comments on the actual changed lines.
**Schedule:** Triggered by GitHub Actions.
**Risk:** `autoApprove: true` inside the workflow — but the runner has only read tools and `write_file` to `/tmp`. The agent cannot push, comment, or merge. Posting comments is done by a downstream `actions/github-script` step parsing the agent's JSON output.
**Tools used:** `git_diff`, `git_log`, `read_file`, `find`, `grep`, `ls`, `http_request`, `web_search`, `load_skill`, `write_file`.

## Why this is useful

This is the recipe Jazz uses on its own pull requests. Generic "AI PR reviewers" tend to spray boilerplate. This one:

- Writes its findings to a JSON array with `path` / `line` / `side` / `body`.
- The CI step **validates each comment against the actual diff hunks** before posting — comments referencing lines outside the diff get rolled into a review-body section instead of being rejected by the GitHub API.
- Spawns sub-agents on large PRs (10+ files or 500+ lines) to review batches in parallel.

## The workflow file (`.github/jazz/workflows/code-review/WORKFLOW.md`)

Trimmed for the cookbook — see the full version in this repo for the complete checklist.

```markdown
---
name: code-review
description: Review pull request changes for quality, security, and correctness
autoApprove: true
agent: ci-reviewer
maxIterations: 100
skills:
  - code-review
---

# Pull Request Code Review

Review the changes in this pull request.

**Collect ALL issues, never stop at first error**: You MUST review the entire PR and return every issue you find.

**Write to a file**: Use `write_file` to accumulate issues in a scratch file. **Always write to /tmp only** — e.g. `/tmp/jazz-review-issues.md`. Never write to the repo workspace.

**Large PRs — `spawn_subagent`**: If the PR has 10+ files or 500+ lines, spawn subagents to review batches in parallel. Aggregate.

To get the diff, use the `git_diff` tool with `commit` set to `__PR_BASE_SHA__...__PR_HEAD_SHA__`.

## Workflow

1. Get the file list: `git_diff` with `commit` and `nameOnly: true`.
2. Get the diff content. If small (<~500 lines), full diff. If large, batches of 5–10 files.
3. Use the `code-review` skill for the full checklist.

## Output Format

You MUST output ONLY a JSON array as the very last thing you write, wrapped in a four-backtick fenced code block. Each element:

```
{
  "path": "src/example.ts",
  "line": 42,
  "side": "RIGHT",
  "body": "**Critical**: This can throw if `user` is null.\n\nSuggestion:\n```ts\nif (!user) return;\n```"
}
```

Rules:
- `path`: relative file path from repo root (must exist in the diff)
- `line`: NEW version (RIGHT) for added/modified, OLD (LEFT) for deleted
- `side`: `RIGHT` for new code; `LEFT` or omit for deleted files
- `body`: markdown — include severity (Critical/Suggestion/Nice-to-have) and a concrete fix

**CRITICAL — Line number accuracy:** the `line` MUST appear in the diff hunks. Lines outside the diff are rejected by the GitHub API. If the line you want to comment on is not in the diff, attach the comment to the nearest valid diff line and reference the real line in the body.

If there are no issues, output `[]`.
```

## The agent config (`.github/jazz/agents/ci-reviewer.json`)

```json
{
  "id": "ci-reviewer",
  "name": "ci-reviewer",
  "description": "CI code review agent",
  "model": "openai/gpt-4o-mini",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-4o-mini",
    "reasoningEffort": "medium",
    "tools": [
      "find",
      "grep",
      "ls",
      "read_file",
      "git_diff",
      "git_log",
      "http_request",
      "web_search",
      "load_skill",
      "load_skill_section",
      "context_info",
      "summarize_context",
      "write_file"
    ]
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## How to install

```bash
# In your repo:
mkdir -p .github/jazz/workflows/code-review .github/jazz/agents .github/workflows

# WORKFLOW.md (paste the content above; keep the __PR_BASE_SHA__ / __PR_HEAD_SHA__ placeholders)
$EDITOR .github/jazz/workflows/code-review/WORKFLOW.md

# Agent config
$EDITOR .github/jazz/agents/ci-reviewer.json

# Driver workflow
$EDITOR .github/workflows/jazz.yml
```

A minimal `jazz.yml` driver (the full version in this repo also adds an on-demand `/jazz` assistant job):

```yaml
name: Jazz
on:
  pull_request:
    types: [opened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  resolve:
    runs-on: ubuntu-latest
    outputs:
      pr_number: ${{ steps.r.outputs.pr_number }}
      base_sha: ${{ steps.r.outputs.base_sha }}
      head_sha: ${{ steps.r.outputs.head_sha }}
      pr_head_repo_full_name: ${{ steps.r.outputs.pr_head_repo_full_name }}
    steps:
      - id: r
        uses: actions/github-script@v7
        with:
          script: |
            let prNumber, baseSha, headSha, repo;
            if (context.payload.pull_request) {
              const pr = context.payload.pull_request;
              prNumber = pr.number; baseSha = pr.base.sha; headSha = pr.head.sha;
              repo = pr.head.repo.full_name;
            } else {
              const issueNumber = context.payload.issue.number;
              const { data: pr } = await github.rest.pulls.get({
                owner: context.repo.owner, repo: context.repo.repo, pull_number: issueNumber,
              });
              prNumber = pr.number; baseSha = pr.base.sha; headSha = pr.head.sha;
              repo = pr.head.repo.full_name;
            }
            core.setOutput('pr_number', String(prNumber));
            core.setOutput('base_sha', baseSha);
            core.setOutput('head_sha', headSha);
            core.setOutput('pr_head_repo_full_name', repo);

  code-review:
    needs: resolve
    runs-on: ubuntu-latest
    if: |
      (github.event_name == 'pull_request'
        && github.event.pull_request.head.repo.full_name == github.repository) ||
      (github.event_name == 'issue_comment'
        && github.event.issue.pull_request != null
        && contains(github.event.comment.body, '/jazz-review')
        && (github.event.comment.author_association == 'OWNER'
          || github.event.comment.author_association == 'MEMBER'
          || github.event.comment.author_association == 'COLLABORATOR')
        && needs.resolve.outputs.pr_head_repo_full_name == github.repository)
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.resolve.outputs.head_sha }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm install -g jazz-ai
      - env:
          PR_BASE_SHA: ${{ needs.resolve.outputs.base_sha }}
          PR_HEAD_SHA: ${{ needs.resolve.outputs.head_sha }}
        run: |
          mkdir -p "$HOME/.jazz/agents" workflows/code-review
          cp .github/jazz/agents/ci-reviewer.json "$HOME/.jazz/agents/"
          sed -e "s/__PR_BASE_SHA__/$PR_BASE_SHA/g" \
              -e "s/__PR_HEAD_SHA__/$PR_HEAD_SHA/g" \
            .github/jazz/workflows/code-review/WORKFLOW.md \
            > workflows/code-review/WORKFLOW.md
      - env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          CI: "true"
          JAZZ_DISABLE_CATCH_UP: "1"
        run: |
          set -euo pipefail
          jazz --output raw workflow run code-review \
            --auto-approve --agent ci-reviewer \
            | tee /tmp/jazz-review.txt
      - if: always()
        env:
          PR_NUMBER: ${{ needs.resolve.outputs.pr_number }}
          PR_HEAD_SHA: ${{ needs.resolve.outputs.head_sha }}
        uses: actions/github-script@v7
        with:
          script: |
            // (Full diff-validation + posting logic lives in this repo's
            //  .github/workflows/jazz.yml — about 180 lines. Copy it in.)
```

For the full `actions/github-script` step that parses the JSON output, validates each comment against the diff hunks, and falls back to general comments for out-of-diff lines, copy [`/.github/workflows/jazz.yml`](../../.github/workflows/jazz.yml) verbatim from this repo.

## How to customize

- **Different model** — change the `llmProvider` / `llmModel` / `reasoningEffort` in `ci-reviewer.json`. The CI workflow surfaces the model name in the review header.
- **Stricter / looser tone** — edit the WORKFLOW.md "What To Do" / "What NOT To Do" lists. They control whether the reviewer flags style nits.
- **Add an on-demand assistant** — copy the `assistant` job from `.github/workflows/jazz.yml` to let trusted reviewers post `/jazz <request>` and get a tailored answer on the PR.
- **Self-hosted runner** — works the same; install `jazz-ai` on the runner image instead of `npm install -g` per run.

## What you'll see

When a PR opens, GitHub shows an "AI Code Review" check running. ~1–3 minutes later, a review appears with inline comments tied to specific lines, plus a top-level summary like:

> ## Jazz Code Review
>
> Found 4 comment(s).
>
> *Model: openai/gpt-4o-mini*

If there are no issues, the bot posts a single comment: `## Jazz Code Review — No issues found.`

## Limits

- **Costs an LLM API key.** Per-PR cost varies with diff size; the recipe spawns sub-agents to keep context bounded.
- The reviewer is **fork-PR safe by default** — the `if:` clause requires `head.repo.full_name == github.repository`, so PRs from forks don't get to use your secrets.
- Inline comments only land on lines that are part of the diff hunks. Out-of-diff comments are still posted, but as part of the review summary body.

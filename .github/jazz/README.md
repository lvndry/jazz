# Jazz on GitHub Actions — AI PR review + assistant

This directory plus [`.github/workflows/jazz.yml`](../workflows/jazz.yml) run the
[`jazz-ai`](https://www.npmjs.com/package/jazz-ai) CLI in CI to review pull
requests and answer questions about them. It's designed to be copied into any
repo. This is the guide for doing that.

## What you get

- **Automatic code review** on every PR (opened / marked ready). Posts a verdict
  plus inline, line-level comments.
- **On-demand PR assistant** — comment `/jazz <question>` on a PR and it answers,
  grounded in the actual diff and code (reviews, summaries, "why does X work",
  change suggestions).

## Quick start

1. Copy two things into your repo, keeping the paths:
   - `.github/workflows/jazz.yml`
   - `.github/jazz/` (this whole directory)
2. Add **one repo secret** for your model provider (Settings → Secrets and
   variables → Actions):
   - `OPENROUTER_API_KEY` — if you use OpenRouter (the default here), **or**
   - `OPENAI_API_KEY` — if you point the agents at OpenAI.
   - `GITHUB_TOKEN` is provided automatically; you don't create it.
3. Customize for your stack (see below).
4. Open a PR, or comment `/jazz summarize this PR`.

## Required secrets

| Secret | Needed? | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | automatic | Read PR context, post comments (no action needed) |
| `OPENROUTER_API_KEY` | if using OpenRouter | Model access for the agents |
| `OPENAI_API_KEY` | if using OpenAI | Model access for the agents |

You only need the key that matches the provider in your agent configs.

## File structure

```
.github/
  workflows/jazz.yml                     # the GitHub Actions workflow
  jazz/
    agents/
      ci-reviewer.json                   # agent for /jazz-review (inline review)
      pr-assistant.json                  # agent for /jazz (conversational)
    workflows/
      code-review/WORKFLOW.md            # instructions for the reviewer
      pr-assistant/WORKFLOW.md           # instructions for the assistant
```

The workflow copies the agent JSON to `~/.jazz/agents/`, substitutes the PR's
SHAs into the `WORKFLOW.md` template (`__PR_BASE_SHA__`, `__PR_HEAD_SHA__`,
`__WORKSPACE__`, …), and runs `jazz workflow run …`.

## Customize for your project

Two files almost certainly need editing — the defaults are tuned for **this**
(TypeScript / Bun / Effect-TS) repo:

1. **`agents/*.json` — pick your model.** Both agents default to
   `cohere/north-mini-code:free` via OpenRouter with `reasoningEffort: medium`.
   Swap `model` / `llmModel` / `llmProvider` for whatever you want. A stronger
   (paid) model gives noticeably better reviews on large diffs.
2. **`workflows/code-review/WORKFLOW.md` — match your codebase.** Its **"Runtime
   Model"** section describes Jazz's specifics (single-threaded JS, Effect-TS
   error channels, Bun). Replace it with your language, framework, and the risk
   areas that matter for your project — otherwise the reviewer applies
   assumptions that don't fit your stack.

Everything else (the diff-inspection steps, the output contract, the
truncation-safety guidance) is project-agnostic and can be copied as-is.

## Commands

| You do | What runs |
|---|---|
| Open a PR / mark ready | Automatic code review (inline comments) |
| Comment `/jazz-review` | Re-run the code review |
| Comment `/jazz <question>` | PR assistant answers your request |
| Actions tab → Run workflow | Manual dispatch (choose `code-review` or `assistant`) |

Note: `/jazz review` (space) is **not** `/jazz-review` (hyphen). The space form
goes to the conversational assistant; the hyphen form runs the inline reviewer.

## Who can trigger it

Comment triggers are restricted to trusted authors — `OWNER`, `MEMBER`, or
`COLLABORATOR`. Comments from other users are ignored, so drive-by commenters
can't spend your model budget.

## Forks and security

The jobs only run for PRs from **the same repository** (a
`pr_head_repo_full_name == github.repository` guard). PRs from **forks are
skipped** — a fork's `GITHUB_TOKEN` is read-only and has no access to your
secrets, so the reviewer can't run there safely. If you need review on external
contributors' PRs, that's the point where a GitHub App (with its own installation
token) becomes the right tool instead of Actions.

## Cost and free-tier behavior

The code-review job **does not fail CI** when the model provider throttles or
errors — it posts a "could not run, re-run to retry" notice instead of a red X,
so a rate-limited free tier doesn't spam failures. Swap in a paid model if you
want reliable, higher-quality reviews.

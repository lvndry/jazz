# Jazz on GitHub Actions. AI PR review + assistant

This directory plus [`.github/workflows/jazz.yml`](../workflows/jazz.yml) run the
[`jazz-ai`](https://www.npmjs.com/package/jazz-ai) CLI in CI to review pull
requests and answer questions about them. It's designed to be copied into any
repo. This is the guide for doing that.

## What you get

- **Automatic code review** on every PR (opened / marked ready). Posts a verdict
  plus inline, line-level comments.
- **On-demand PR assistant**: comment `/jazz <question>` on a PR and it answers,
  grounded in the actual diff and code (reviews, summaries, "why does X work",
  change suggestions).

## Quick start

1. Copy two things into your repo, keeping the paths:
   - `.github/workflows/jazz.yml`
   - `.github/jazz/` (this whole directory)
2. Add **one repo secret** for your model provider (Settings → Secrets and
   variables → Actions): `<PROVIDER>_API_KEY`, for whichever provider your agent
   configs name. `OPENAI_API_KEY` for the checked-in ones, `ANTHROPIC_API_KEY`,
   `OPENROUTER_API_KEY`, `GROQ_API_KEY`, and so on. The workflow passes
   `OPENAI_API_KEY`; for another provider add its variable beside that line in
   `jazz.yml` (one line, both jobs).
   - `GITHUB_TOKEN` is provided automatically; you don't create it.
3. Customize for your stack (see below).
4. Open a PR, or comment `/jazz summarize this PR`.

## Required secrets

| Secret               | Needed?                               | Purpose                                           |
| -------------------- | ------------------------------------- | ------------------------------------------------- |
| `GITHUB_TOKEN`       | automatic                             | Read PR context, post comments (no action needed) |
| `<PROVIDER>_API_KEY` | one, for the provider your agents use | Model access for the agents                       |

You only need the key that matches the provider in your agent configs ,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, whichever it is. The full list of environment
variable names is in [Model providers](https://jazz.tools/docs/configure/providers).

`jazz.yml` ships passing `OPENAI_API_KEY`, since the checked-in agents run on
OpenAI. On another provider, add that provider's line next to it in both the
`Run code review` and `Run Jazz assistant` steps:

```yaml
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} # ← yours
```

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

Two files almost certainly need editing: the defaults are tuned for **this**
(TypeScript / Bun / Effect-TS) repo:

1. **`agents/*.json`: pick your model.**
   Change `llmProvider`, `llmModel`, and optionally `reasoning` (for example `medium`, or `disable`). The checked-in configs use `openai/gpt-5.4-mini`; use the provider key that matches your choice.
2. **`workflows/code-review/WORKFLOW.md`: match your codebase.** Its **"Runtime
   Model"** section describes Jazz's specifics (single-threaded JS, Effect-TS
   error channels, Bun). Replace it with your language, framework, and the risk
   areas that matter for your project: otherwise the reviewer applies
   assumptions that don't fit your stack.

Everything else (the diff-inspection steps, the output contract, the
truncation-safety guidance) is project-agnostic and can be copied as-is.

## Commands

| You do                     | What runs                                             |
| -------------------------- | ----------------------------------------------------- |
| Open a PR / mark ready     | Automatic code review (inline comments)               |
| Comment `/jazz-review`     | Re-run the code review                                |
| Comment `/jazz <question>` | PR assistant answers your request                     |
| Actions tab → Run workflow | Manual dispatch (choose `code-review` or `assistant`) |

Note: `/jazz review` (space) is **not** `/jazz-review` (hyphen). The space form
goes to the conversational assistant; the hyphen form runs the inline reviewer.

## Who can trigger it

Comment triggers are restricted to trusted authors. `OWNER`, `MEMBER`, or
`COLLABORATOR`. Comments from other users are ignored, so drive-by commenters
can't spend your model budget.

## What the agent can reach

The diff, the PR text and its comments are untrusted input to an agent with shell
access, so the workflow keeps that agent's reach small:

- **No GitHub token.** Checkouts use `persist-credentials: false`. Only the
  snapshot step and the posting steps hold `GITHUB_TOKEN`; the agent reads a
  static JSON file and prints its answer, and the posting steps write to GitHub.
- **Only trusted comments.** The snapshot keeps comments and reviews from
  `OWNER`, `MEMBER` and `COLLABORATOR` authors, plus the workflow's own earlier
  reviews (the `github-actions` bot). Other comments are dropped.
- **Read-only.** Both workflows use `autoApprove: read-only`: a shell command
  runs only if Jazz's command classifier judges it read-only, which covers the
  `git diff`/`git log` reads the reviewers need. The agents have no
  `http_request` and no file-writing tools.
- **Bounded.** Each job has `timeout-minutes`; each run passes
  `--max-cost-usd "$JAZZ_MAX_COST_USD"`, set once at the top of `jazz.yml`.

## Forks and security

The jobs only run for PRs from **the same repository** (a
`pr_head_repo_full_name == github.repository` guard). PRs from **forks are
skipped**: a fork's `GITHUB_TOKEN` is read-only and has no access to your
secrets, so the reviewer can't run there safely. If you need review on external
contributors' PRs, that's the point where a GitHub App (with its own installation
token) becomes the right tool instead of Actions.

## Cost and failures

When a run fails, the PR comment and the job summary say why, for example
"Review skipped: provider authentication failed." A rate limit or timeout only
warns, so a throttled free tier doesn't paint CI red. A setup problem, such as a
rejected or missing API key, fails the job so it gets noticed. Raise
`JAZZ_MAX_COST_USD` in `jazz.yml` if reviews on large PRs stop at the cap.

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
2. Set up ChatGPT credentials:
   - In Jazz, open **Settings → LLM Providers → ChatGPT** and press `c` to copy
     the credential bundle. Add it as the `JAZZ_CHATGPT_CREDENTIAL` repository
     secret (Settings → Secrets and variables → Actions).
   - Create a GitHub App installed on this repository with only the repository
     **Secrets: write** permission. Add its App ID and private key as
     `JAZZ_GITHUB_APP_ID` and `JAZZ_GITHUB_APP_PRIVATE_KEY` Actions secrets.
     The workflow mints a short-lived installation token only after Jazz rotates
     the OAuth credential, then updates `JAZZ_CHATGPT_CREDENTIAL` automatically.
   - `GITHUB_TOKEN` is provided automatically; you don't create it.
3. Customize for your stack (see below).
4. Open a PR, or comment `/jazz summarize this PR`.

## Required secrets

| Secret                        | Needed?                       | Purpose                                           |
| ----------------------------- | ----------------------------- | ------------------------------------------------- |
| `GITHUB_TOKEN`                | automatic                     | Read PR context, post comments (no action needed) |
| `JAZZ_CHATGPT_CREDENTIAL`     | required                      | ChatGPT OAuth bundle used by the agents           |
| `JAZZ_GITHUB_APP_ID`          | required for rotation updates | Identifies the repository scoped GitHub App       |
| `JAZZ_GITHUB_APP_PRIVATE_KEY` | required for rotation updates | Mints a short lived secret updater token          |

The code reviewer uses `chatgpt/gpt-6-luna`; the PR assistant uses
`chatgpt/gpt-5.6-luna`. Both use your ChatGPT plan's usage limits. To use API
billing instead, change both agent configs and pass the matching provider API
key to both Jazz run steps.

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
   Change `llm.provider`, `llm.model`, and optionally `reasoning` (for example `medium`, or `disable`). The checked-in reviewer uses `chatgpt/gpt-6-luna`; the assistant uses `chatgpt/gpt-5.6-luna`.
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
- **Separate secret updater access.** The ChatGPT credential is available to
  trusted same-repository runs. A repository scoped GitHub App token with only
  **Secrets: write** is minted after Jazz exits, only when its refresh token
  rotated, and is used only to update `JAZZ_CHATGPT_CREDENTIAL`.
- **Only trusted comments.** The snapshot keeps comments and reviews from
  `OWNER`, `MEMBER` and `COLLABORATOR` authors, plus the workflow's own earlier
  reviews (the `github-actions` bot). Other comments are dropped.
- **Read-only.** Both workflows use `autoApprove: read-only`: a shell command
  runs only if Jazz's command classifier judges it read-only, which covers the
  `git diff`/`git log` reads the reviewers need. The agents have no
  `http_request` and no file-writing tools.
- **Bounded.** Each job has `timeout-minutes`; each run passes
  `--max-cost-usd "$JAZZ_MAX_COST_USD"`, set once at the top of `jazz.yml`.
- **Rotating OAuth credential.** Runs are serialized across this repository
  because ChatGPT refresh tokens rotate and are single use. The updater App
  token is created only after Jazz exits and only when a refresh occurred. Keep
  all workflows using this ChatGPT credential in the same concurrency queue.
  If a runner is canceled or the secret update fails after OpenAI rotates the
  token, sign in again and replace `JAZZ_CHATGPT_CREDENTIAL` with a fresh bundle.

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

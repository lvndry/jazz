# Jazz on GitHub Actions

This directory plus [`.github/workflows/jazz.yml`](../workflows/jazz.yml) run the
[`jazz-ai`](https://www.npmjs.com/package/jazz-ai) CLI in CI to review pull
requests and answer questions about them. The separate
[`pre-release-review.yml`](../workflows/pre-release-review.yml) action reviews all unreleased
commits and proposes verified fixes in one pull request. This guide covers setup and operation.

## What you get

- **Automatic code review** on every PR (opened / marked ready). Posts a verdict
  plus inline, line-level comments.
- **On-demand PR assistant**: comment `/jazz <question>` on a PR and it answers,
  grounded in the actual diff and code (reviews, summaries, "why does X work",
  change suggestions).
- **Manual pre-release review**: run **Pre Release Review** from the Actions tab to review the
  pinned `main` snapshot against the latest published release, fix verified introduced bugs, and
  open one pull request when there are changes. It does not start a release.

## Quick start

1. Copy the workflow and its configuration into your repo, keeping the paths:
   - `.github/workflows/jazz.yml`
   - `.github/jazz/` (this whole directory)
   - For pre-release reviews, also copy `.github/workflows/pre-release-review.yml` and
     `scripts/pre-release-review.ts`. The copied `.github/jazz/` directory must include
     `pre-release-review.Dockerfile`, the pre-release agent, and its workflow prompt.
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
3. For pre-release reviews, configure `RELEASE_PAT` as described below.
4. Customize for your stack (see below).
5. Open a PR, comment `/jazz summarize this PR`, or run **Pre Release Review** manually.

## Required secrets

| Secret                        | Needed?                       | Purpose                                           |
| ----------------------------- | ----------------------------- | ------------------------------------------------- |
| `GITHUB_TOKEN`                | automatic                     | Read PR context, post comments (no action needed) |
| `JAZZ_CHATGPT_CREDENTIAL`     | required                      | ChatGPT OAuth bundle used by the agents           |
| `JAZZ_GITHUB_APP_ID`          | required for rotation updates | Identifies the repository scoped GitHub App       |
| `JAZZ_GITHUB_APP_PRIVATE_KEY` | required for rotation updates | Mints a short lived secret updater token          |
| `RELEASE_PAT`                 | pre-release publication       | Pushes the fix branch and opens its pull request  |

The code reviewer and pre-release reviewer use `chatgpt/gpt-6-luna`; the PR assistant and the release
notes agent (run by `release.yml`) use `chatgpt/gpt-5.6-luna`. All use your
ChatGPT plan's usage limits. To use API billing instead, change the agent
configs and pass the matching provider API key to each Jazz run step.

## File structure

```text
.github/
  workflows/jazz.yml                     # PR review and assistant
  workflows/pre-release-review.yml       # manual unreleased-commit review and fix PR
  jazz/
    agents/
      ci-reviewer.json                   # agent for /jazz-review (inline review)
      pr-assistant.json                  # agent for /jazz (conversational)
      pre-release-review.json            # agent for the manual review and fixes
    workflows/
      code-review/WORKFLOW.md            # instructions for the reviewer
      pr-assistant/WORKFLOW.md           # instructions for the assistant
      pre-release-review/WORKFLOW.md     # coverage, verification, fixes, report contract
    pre-release-review.Dockerfile        # disposable review and validation environment
scripts/pre-release-review.ts           # trusted snapshot, report, patch and publication helper
```

The PR workflow copies the agent JSON to `~/.jazz/agents/`, substitutes the PR's
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

| You do                                      | What runs                                             |
| ------------------------------------------- | ----------------------------------------------------- |
| Open a PR / mark ready                      | Automatic code review (inline comments)               |
| Comment `/jazz-review`                      | Re-run the code review                                |
| Comment `/jazz <question>`                  | PR assistant answers your request                     |
| Actions → Jazz → Run workflow               | Manual dispatch (choose `code-review` or `assistant`) |
| Actions → Pre Release Review → Run workflow | Review all unreleased commits; propose one fix PR     |

Note: `/jazz review` (space) is **not** `/jazz-review` (hyphen). The space form
goes to the conversational assistant; the hyphen form runs the inline reviewer.

## Who can trigger it

Comment triggers are restricted to trusted authors. `OWNER`, `MEMBER`, or
`COLLABORATOR`. Comments from other users are ignored, so drive-by commenters
can't spend your model budget.

## What the PR agents can reach

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
- **Read-only PR inspection.** The PR review and assistant prompts use `autoApprove: read-only`: a shell command
  runs only if Jazz's command classifier judges it read-only, which covers the
  `git diff`/`git log` reads the reviewers need. The agents have no
  `http_request` and no file-writing tools.
- **Bounded.** Each job has `timeout-minutes`; each run passes
  `--max-cost-usd "$JAZZ_MAX_COST_USD"` and
  `--max-duration-ms "$JAZZ_MAX_DURATION_MS"`, set once at the top of
  `jazz.yml`. The duration budget sits a few minutes inside the job timeout, so
  the agent writes its answer and the job posts it before GitHub cancels it.
- **Rotating OAuth credential.** Runs are serialized across this repository
  because ChatGPT refresh tokens rotate and are single use. The updater App
  token is created only after Jazz exits and only when a refresh occurred. Keep
  all workflows using this ChatGPT credential in the same concurrency queue, including
  **Pre Release Review**.
  If a runner is canceled or the secret update fails after OpenAI rotates the
  token, sign in again and replace `JAZZ_CHATGPT_CREDENTIAL` with a fresh bundle.

## Run a pre-release review

In **Actions → Pre Release Review → Run workflow**, select **main** and run the action. No
release tag input is needed: the snapshot step resolves the latest published GitHub release and
pins its commit and the current main commit. An unpublished tag does not become the baseline.
The agent is instructed to review every commit in `releaseSha..mainSha` and the union of files
touched by those commits, including changes later reverted, tracing relevant callers and tests.
Main advancing during the run does not change that review's scope.

The agent reads the repository guidance, delegates review batches where useful, reproduces
introduced bugs, and fixes only confirmed problems. Each fix carries meaningful regression
coverage and behavior documentation where needed. It writes a structured completion report only
after full coverage. The validator checks that its declared coverage matches the trusted
snapshot; this does not prove how thoroughly the model read each file. An interrupted run or
missing, incomplete, or invalid report cannot authorize publication.
When the review produces fixes, the action runs all four repository checks plus documentation
validation in a fresh container without the provider credential or review-data mount:

```sh
bun run typecheck
bun run test:typecheck
bun run lint
env -u NO_COLOR bun test
bun run docs:lint
bun run docs:check-links
bun run docs:check-metadata
```

A fresh publication job applies the checked patch to the pinned main commit and uses
`RELEASE_PAT` to push a feature branch and open one pull request. This token must have repository
**Contents: write** and **Pull requests: write** permissions. The publisher rejects patches that
touch any `.github/` path, so generated Actions code cannot run with privileged credentials
before review. Findings requiring changes there remain unresolved for a manual fix. Using this
credential lets the resulting push and pull request trigger normal CI. The existing OAuth updater
App still needs only **Secrets: write**; do not add repository write permissions to it.

There is no empty pull request: a clean review or a report with only unresolved findings leaves
its report without opening one or running the full patch-validation suite. A completed report identifies every confirmed unresolved bug and
why it remains. Fixes with unresolved findings open a draft PR. An already-open pre-release review pull request for the same main snapshot is
skipped rather than duplicated. Download the review report and patch from the run's artifacts to
inspect the handoff; the artifact is named `pre-release-review-<run_id>`. Review and merge the
fix PR manually, then run the release workflow when ready; **Pre Release Review** is not an
automatic release gate and never creates a release.

The review job checks out main with `persist-credentials: false`. A read-only `GITHUB_TOKEN`
fetches the scope snapshot; it is not passed to the agent. Dependency installation runs first in
a separate container with only the checkout mounted, without provider credentials or review
data. The agent runs inside Docker with only the checkout and review-data directories mounted,
at `/workspace` and `/review`. The container receives no host Actions/runtime environment,
GitHub token, or Docker socket. It does
receive the ChatGPT credential, and shared OAuth queuing and post-run rotation updates apply.
Its `autoApprove: high-risk` policy allows unattended edits and targeted tests. Shell access can
change both mounts and reach the network; the container limits host access but does not isolate
the model from mounted files or provider credentials.

Patch collection uses another fresh container and a read-only trusted helper. Full validation
runs without credentials or `/review`. Report and patch artifacts are copied through bounded
regular-file reads to an independent host directory before upload. `RELEASE_PAT` exists only in
the fresh publication job, whose helper uses Bun and Node builtins without installing
dependencies or executing patched repository code.

The agent has a USD 4 cost ceiling and a 42-minute duration budget; the review job allows
75 minutes for setup, validation, and credential rotation. Run limits live in
`pre-release-review.yml`; the agent configuration and detailed review contract
live under `.github/jazz/`. A budget stop, incomplete coverage, failed checks, or invalid report
stops publication and remains visible in the Actions run. The report records checks the agent
actually executed; the separate check step establishes whether the combined patch passes CI.

## Forks and security

The PR jobs only run for PRs from **the same repository** (a
`pr_head_repo_full_name == github.repository` guard). PRs from **forks are
skipped**: a fork's `GITHUB_TOKEN` is read-only and has no access to your
secrets, so the reviewer can't run there safely. If you need review on external
contributors' PRs, that's the point where a GitHub App (with its own installation
token) becomes the right tool instead of Actions.

## Cost and failures

For the PR review and assistant jobs, when a run fails, the PR comment and the job summary say why, for example
"Review skipped: provider authentication failed." A rate limit or timeout only
warns, so a throttled free tier doesn't paint CI red. A setup problem, such as a
rejected or missing API key, fails the job so it gets noticed. Raise
`JAZZ_MAX_COST_USD` in `jazz.yml` if reviews on large PRs stop at the cap.

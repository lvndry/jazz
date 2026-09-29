---
description: "Add Jazz to your CI pipeline for pull-request summaries, code review, release notes, or failed-build analysis, with a GitHub Actions example."
---

# Jazz in CI

Run Jazz in your pipeline when a job needs to interpret code, changes, or logs. It reads
the input, uses the tools you allow, and returns an answer your pipeline can save or publish.

| Job                   | Input                                     | Result                                  |
| --------------------- | ----------------------------------------- | --------------------------------------- |
| Pull-request summary  | The diff and relevant source files        | A summary for reviewers                 |
| Code review           | The diff and your review instructions     | Findings to check before merging        |
| Release notes         | Commits since the previous release        | A draft grouped by user-visible changes |
| Failed-build analysis | Test output, build logs, and source files | Likely causes and suggested fixes       |

Keep your existing tests and linters. A successful Jazz run means it produced an answer;
it does not mean the changes passed review.

## Set up an agent

Create an agent locally with `jazz agent create`, choose a provider and model, then copy
its JSON file from `~/.jazz/agents/` into your repository, for example
`.ci/jazz/agents/ci-helper.json`. Use `ci-helper` as its `id` and `name`.

The runner needs that file and the matching provider credential. Store the API key in
your CI secret store and pass it as an environment variable, such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`. Keep credentials out of the agent file. See
[Agent configuration](../configure/agents.md) and [Model providers](../configure/providers.md).

Test the agent from your checkout before enabling the pipeline:

```sh
jazz run --agent ci-helper --approval-policy read-only --max-iterations 10 \
  "Read this repository and summarize its main components. Do not modify files."
```

## Example: summarize a pull request in GitHub Actions

Add your provider key as a repository Actions secret. This example uses an OpenAI agent
and `OPENAI_API_KEY`; change both for another provider.

Save this as `.github/workflows/jazz-summary.yml`. It reviews same-repository pull requests
and writes the answer to the job summary. It does not post comments or change files.

```yaml
name: Jazz PR summary

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  summarize:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
      - run: bun add -g --trust jazz-ai
      - name: Install the agent configuration
        run: |
          mkdir -p "$HOME/.jazz/agents"
          cp .ci/jazz/agents/ci-helper.json "$HOME/.jazz/agents/"
      - name: Summarize the changes
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          {
            printf '%s\n' 'Summarize this pull request for a reviewer. Describe the behavior changes and anything that needs manual verification. Do not modify files.'
            git diff "$BASE_SHA" "$HEAD_SHA"
          } | jazz run --agent ci-helper --json \
            --approval-policy read-only --max-cost-usd 2 \
            --max-iterations 20 --timeout 600000 > jazz-result.json
          jq -er '.answer' jazz-result.json >> "$GITHUB_STEP_SUMMARY"
```

Full Git history lets the job compare the base and head commits. The read-only policy
allows repository inspection and declines tools above that tier. Jazz exits nonzero if
the run fails, so the job fails rather than publishing a successful summary.

For inline review comments and `/jazz` commands on a pull request, use the
[PR reviewer setup](../guides/pr-review.md).

## Adapt it to another pipeline

GitLab CI, CircleCI, Jenkins, and other runners use the same steps: install Jazz, copy
the agent configuration into `$JAZZ_HOME/agents/`, provide the credential, and run
`jazz run` from the checkout. The example uses Bun; you can also install Jazz with the
[standalone installer](../getting-started/quick-start.md#1-install-the-cli).

You can pipe build logs or release history into the prompt:

```sh
{
  printf '%s\n' 'Explain the failing tests in this log. Read source files if needed. Do not modify files.'
  cat test-output.log
} | jazz run --agent ci-helper --json --approval-policy read-only \
  --max-cost-usd 2 --max-iterations 20 --timeout 600000 > jazz-result.json

jq -er '.answer' jazz-result.json > build-analysis.md
```

To reuse detailed instructions across jobs, save them as a
[workflow](../configure/workflows.md) and call `jazz workflow run`.

## Results and limits

With `--json`, stdout contains one JSON result; status messages and progress go to stderr.
Save stdout separately so your pipeline can read `.ok`, `.answer`, `.error`, and `.costUSD`.
See [Headless runs](./headless.md) for the output fields and exit codes.

Set `--max-cost-usd`, `--max-iterations`, and `--timeout` for each run, plus your CI job's
own timeout. Budget limits can return a partial answer; check the result's cap flags if
your job requires a complete response. Pin the Jazz version and model after validating
the setup in your pipeline.

Publish results in a separate CI step with only the permissions that step needs. If
Jazz's answer will decide whether a build passes, define a structured verdict and validate
it before using it; `.ok` only reports whether the run succeeded.

## Pull requests and credentials

The example skips fork pull requests because GitHub withholds Actions secrets from those
runs. Do not switch it to `pull_request_target` and execute a contributor's checkout with
secrets available. See [GitHub's guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

Treat diffs, logs, and PR text as untrusted input. Start with read-only approvals and
`persist-credentials: false`; a review agent does not need a GitHub token to inspect the
checkout. See [Unattended runs](../security/unattended-runs.md) for approval policies and
credential access.

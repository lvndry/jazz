---
description: "Install Jazz's maintained multi-agent GitHub pull-request reviewer, then choose ChatGPT, an API provider, or a self-hosted model."
---

# Review pull requests in CI with your choice of model

Jazz's own GitHub workflow is the maintained example. It reviews every eligible pull request with specialist subagents, verifies their findings against the diff, and posts a verdict plus line-level comments.

The model never receives permission to post to GitHub. Jazz writes a structured review to stdout; a deterministic `actions/github-script` step validates paths and line numbers against the actual diff before using `GITHUB_TOKEN`.

## What the bundle contains

Copy these paths from the Jazz repository into the same paths in yours:

```text
.github/workflows/jazz.yml
.github/jazz/
  agents/ci-reviewer.json
  agents/pr-assistant.json
  workflows/code-review/WORKFLOW.md
  workflows/pr-assistant/WORKFLOW.md
```

The Jazz repository also includes a release-notes agent and workflow. They are not required for pull-request review.

Use the files themselves as the template rather than copying a shortened YAML block from this page:

- [GitHub Actions driver](../../.github/workflows/jazz.yml)
- [Reviewer agent](../../.github/jazz/agents/ci-reviewer.json)
- [Review workflow](../../.github/jazz/workflows/code-review/WORKFLOW.md)
- [PR assistant agent](../../.github/jazz/agents/pr-assistant.json)
- [PR assistant workflow](../../.github/jazz/workflows/pr-assistant/WORKFLOW.md)

## Configure the provider

The supplied reviewer uses `chatgpt/gpt-6-luna`; the PR assistant uses
`chatgpt/gpt-5.6-luna`. To use them with your ChatGPT plan:

1. In Jazz, open **Settings → LLM Providers → ChatGPT**, sign in, and press `c`
   to copy the credential bundle. Save it as the `JAZZ_CHATGPT_CREDENTIAL`
   repository Actions secret.
2. Set up the GitHub App and secrets described in the [Actions setup](../../.github/jazz/README.md#quick-start)
   so the workflow can save rotated credentials.

To use API billing, change `llmProvider` and `llmModel` in both agent files.
For example:

```json
{
  "config": {
    "llm": {
      "provider": "openrouter",
      "model": "openrouter/free",
      "reasoning": "medium"
    }
  }
}
```

Add the matching repository secret, such as `OPENROUTER_API_KEY`, and pass it
through `env` in both workflow run steps. Remove the ChatGPT credential checks
and rotation steps when switching to an API provider. Provider variable names
are listed in [Model providers](../configure/providers.md).

`openrouter/free` is useful for evaluating the workflow without selecting a paid model, but routing and availability vary. Pin a specific model for consistent reviews.

## Use your own Ollama model

Run the job on a self-hosted GitHub runner that can reach Ollama. Remove the
ChatGPT credential checks and rotation steps from `jazz.yml`. A GitHub-hosted runner cannot reach the Ollama server bound to your laptop's `localhost`.

Change the reviewer agent:

```json
{
  "config": {
    "llm": {
      "provider": "ollama",
      "model": "qwen3-coder",
      "reasoning": "medium",
      "numCtx": 32768
    }
  }
}
```

Keep the existing persona and tool list. Configure `llm.ollama.base_url` on the runner when the server is not local, and smoke-test before enabling automatic reviews:

```bash
ollama pull qwen3-coder
mkdir -p "$HOME/.jazz/agents"
cp .github/jazz/agents/ci-reviewer.json "$HOME/.jazz/agents/"
jazz run --agent ci-reviewer --max-iterations 5 \
  "Inspect this checkout and name its primary language. Do not modify files."
```

## Customize the reviewer for the repository

Edit `.github/jazz/workflows/code-review/WORKFLOW.md`:

- replace Jazz-specific runtime assumptions with your stack and trust boundaries;
- keep the requirement to inspect every changed file;
- keep subagents isolated by review lens;
- require the parent to reproduce findings before publishing them;
- preserve the strict two-block output contract consumed by the Actions parser.

The reviewer agent needs repository reads, git inspection, context tools, and `spawn_subagent`. It does not need `git push`, merge permissions, or GitHub credentials.

## Security behavior

The maintained Actions workflow:

- skips fork pull requests so untrusted workflow changes cannot receive provider secrets;
- accepts `/jazz` and `/jazz-review` only from owners, members, or collaborators;
- checks out the resolved pull-request head with full history and `persist-credentials: false`, so no GitHub token is left in `.git/config`;
- gives the agent only comments and reviews from owners, members, collaborators, and the workflow's own bot;
- runs the agent at `autoApprove: read-only`, where the command classifier admits read-only commands such as `git diff`, and without `http_request`;
- caps each run with `--max-cost-usd` and each job with `timeout-minutes`;
- validates every proposed inline comment against real diff hunks;
- converts invalid line comments into general review text instead of failing the GitHub API call;
- uses job-scoped GitHub permissions;
- treats provider failure as “not reviewed,” never as approval, and names the cause in the comment and the job summary.

The pull-request diff, title, body, and comments are untrusted model input. Keep the reviewer read-only and let the deterministic posting step own mutation.

## Verify the installation

Open a same-repository pull request or run the workflow manually with a pull-request number. The result should contain:

- a verdict naming how many changed files were reviewed;
- one verdict per required review lens;
- inline comments only on lines present in the diff;
- a visible “could not review” notice if the provider fails or returns unusable output.

Comment `/jazz-review` to rerun the review. Comment `/jazz <question>` to invoke the separate PR assistant against the same resolved pull-request context.

Read [CI as a Jazz surface](../surfaces/ci.md), [Headless runs](../surfaces/headless.md), and [Delegation](../concepts/agents.md#delegation).

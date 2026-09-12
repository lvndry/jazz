---
description: "Install Jazz's maintained multi-agent GitHub pull-request reviewer, then run it with OpenRouter, OpenAI, or a self-hosted Ollama model."
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

Keeping the executable example in one place prevents the documentation and production workflow from drifting apart.

## Configure the provider

The checked-in reviewer currently pins the provider and model in `.github/jazz/agents/ci-reviewer.json`. Change only these fields to use another model:

```json
{
  "config": {
    "llmProvider": "openrouter",
    "llmModel": "openrouter/free",
    "reasoningEffort": "medium"
  }
}
```

Add the matching repository secret:

`<PROVIDER>_API_KEY`, for whichever provider the agent names — `OPENROUTER_API_KEY`
here, `OPENAI_API_KEY` for the checked-in configs, `ANTHROPIC_API_KEY`,
`MISTRAL_API_KEY`, and so on; the variable names are in
[Model providers](../configure/providers.md). `jazz.yml` passes `OPENAI_API_KEY` as
shipped, so a different provider also needs its `<PROVIDER>_API_KEY:` line added to the
workflow's two `Run` steps.

`openrouter/free` is useful for evaluating the workflow without selecting a paid model, but routing and availability vary. Pin a specific model for stable review quality and meaningful evals.

## Use your own Ollama model

Run the job on a self-hosted GitHub runner that can reach Ollama. A GitHub-hosted runner cannot reach the Ollama server bound to your laptop's `localhost`.

Change the reviewer agent:

```json
{
  "config": {
    "llmProvider": "ollama",
    "llmModel": "qwen3-coder",
    "numCtx": 32768,
    "reasoningEffort": "medium"
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

The GitHub workflow, subagent protocol, output parser, and line validation do not depend on the model provider.

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
- checks out the resolved pull-request head with full history;
- validates every proposed inline comment against real diff hunks;
- converts invalid line comments into general review text instead of failing the GitHub API call;
- uses job-scoped GitHub permissions;
- treats provider failure as “not reviewed,” never as approval.

The pull-request diff, title, body, and comments are untrusted model input. Keep the reviewer read-only and let the deterministic posting step own mutation.

## Verify the installation

Open a same-repository pull request or run the workflow manually with a pull-request number. The result should contain:

- a verdict naming how many changed files were reviewed;
- one verdict per required review lens;
- inline comments only on lines present in the diff;
- a visible “could not review” notice if the provider fails or returns unusable output.

Comment `/jazz-review` to rerun the review. Comment `/jazz <question>` to invoke the separate PR assistant against the same resolved pull-request context.

## Why this is a Jazz workflow

- Large reviews fan out into isolated specialist contexts instead of one anchored conversation.
- The parent cross-examines subagent results and owns the final verdict.
- Provider choice is an agent setting, not part of the GitHub integration.
- Headless stdout is a clean machine contract while progress stays on stderr.
- GitHub mutation remains outside the model's capabilities.

Read [CI as a Jazz surface](../surfaces/ci.md), [Headless runs](../surfaces/headless.md), and [Delegation](../concepts/agents.md#delegation) for the underlying contracts.

# release-notes-draft

**What it does:** Triggered by a manual GitHub Actions dispatch (or a `git tag` push), drafts release notes from the commits since the previous tag, grouped by feature area, and creates a GitHub Release.
**Schedule:** Triggered by CI, not cron.
**Risk:** `autoApprove: true` inside the workflow — but the runner only has the tools and secrets you give it, so this is safe by construction. The agent can read git, search, and write to `/tmp`; it can't push code.
**Tools used:** `git_log`, `git_diff`, `read_file`, `grep`, `find`, `web_search`, `write_file`.

## Why this is useful

This is exactly what Jazz uses for itself — the `release.yml` action in this repo. The point isn't another `git log --pretty` summary; the point is that an LLM reads the actual diff, groups changes by *feature area* (not by commit type), and writes notes a user would actually want to read.

## The workflow file (committed at `.github/jazz/workflows/release-notes/WORKFLOW.md`)

This is the literal recipe in this repo. The `__NEW_TAG__`, `__PREVIOUS_TAG__`, and `__REPO__` placeholders are substituted at runtime by `release.yml`.

```markdown
---
name: release-notes
description: Generate release notes by analyzing commits between git tags
autoApprove: true
agent: release-notes
maxIterations: 100
---

# Release Notes Generation

Generate release notes for **__NEW_TAG__** by comparing commits since **__PREVIOUS_TAG__**.

## Steps

1. Use `git_log` to get all commits between `__PREVIOUS_TAG__` and `__NEW_TAG__`.
2. Use `git_diff` with `commit` set to `__PREVIOUS_TAG__...__NEW_TAG__` to understand the scope of changes. If the diff is large, scope to individual files using the `path` parameter.
3. Read relevant source files to understand the context of changes.
4. Group commits by **feature** — cluster related changes into cohesive product areas (e.g. "Agent workflows", "CLI experience", "Scheduler"). Each group = one feature or capability area.
5. Write **funny, exciting, product- and UX-focused** descriptions. Explain what changed and **why it matters** to the user. No dry dev-speak — make it feel alive and clear.
6. Skip trivial commits (version bump, merge commit).

## Output Format

You MUST output a single markdown fenced code block (use FOUR backticks) as the very last thing you write. Do NOT output anything after it.

The content inside the block should follow this structure:

` ` ` `markdown
## What's Changed

### [Feature Group Name]
Exciting, funny, product-focused description of what shipped and why users should care. Focus on value and UX.

### [Another Feature Group]
Same vibe — what changed, what problem it solves, why it's awesome.

---

## Commits

- `abc1234` Commit message by @user
- `def5678` Another commit message by @user

## Full diff

[__PREVIOUS_TAG__...__NEW_TAG__](https://github.com/__REPO__/compare/__PREVIOUS_TAG__...__NEW_TAG__)
` ` ` `

Rules:
- Group by **feature/product area**, not by type (Features, Bug Fixes, etc.).
- Tone: funny, exciting, clear — product and UX first.
- Each section header is the feature name; the paragraph sells the value.
- Include the full commit list at the bottom.
- Always include the diff link (__REPO__ is substituted with owner/repo, e.g. `lvndry/jazz`).
- Reference PR numbers in descriptions when available.
```

> The four-backtick fence in the actual file is a real four-backtick fence — GitHub-flavored markdown. Inside the snippet above we render it as `` ` ` ` ` `` so you can see it.

## The CI workflow that runs it (`.github/workflows/release.yml`)

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version_type:
        description: "Version bump type"
        required: true
        type: choice
        options: [patch, minor, major]

permissions:
  contents: write

jobs:
  tag:
    runs-on: ubuntu-latest
    outputs:
      new_tag: ${{ steps.bump.outputs.new_tag }}
      previous_tag: ${{ steps.bump.outputs.previous_tag }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0
          token: ${{ secrets.RELEASE_PAT }}
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
      - id: prev_tag
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
          echo "tag=$PREV_TAG" >> "$GITHUB_OUTPUT"
      - id: bump
        run: |
          npm version ${{ inputs.version_type }} --no-git-tag-version
          NEW_VERSION=$(node -p "require('./package.json').version")
          NEW_TAG="v${NEW_VERSION}"
          git add package.json
          git commit -m "${NEW_VERSION}"
          git tag -a "${NEW_TAG}" -m "${NEW_TAG}"
          git push origin main --follow-tags
          echo "new_tag=${NEW_TAG}" >> "$GITHUB_OUTPUT"
          echo "previous_tag=${{ steps.prev_tag.outputs.tag }}" >> "$GITHUB_OUTPUT"

  release:
    needs: tag
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ needs.tag.outputs.new_tag }}
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm install -g jazz-ai
      - name: Setup Jazz agent and workflow
        env:
          NEW_TAG: ${{ needs.tag.outputs.new_tag }}
          PREVIOUS_TAG: ${{ needs.tag.outputs.previous_tag }}
          REPO: ${{ github.repository }}
        run: |
          mkdir -p "$HOME/.jazz/agents" workflows/release-notes
          cp .github/jazz/agents/release-notes.json "$HOME/.jazz/agents/"
          sed -e "s/__NEW_TAG__/$NEW_TAG/g" \
              -e "s/__PREVIOUS_TAG__/$PREVIOUS_TAG/g" \
              -e "s|__REPO__|$REPO|g" \
            .github/jazz/workflows/release-notes/WORKFLOW.md \
            > workflows/release-notes/WORKFLOW.md
      - name: Generate release notes
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          CI: "true"
          JAZZ_DISABLE_CATCH_UP: "1"
        run: |
          jazz --output raw workflow run release-notes \
            --auto-approve --agent release-notes \
            2>&1 | tee /tmp/jazz-release-notes.txt
      - name: Create GitHub release
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.RELEASE_PAT }}
          script: |
            const fs = require('fs');
            const output = fs.readFileSync('/tmp/jazz-release-notes.txt', 'utf8');
            let mdBlocks = [...output.matchAll(/````markdown\s*\n([\s\S]*?)````/g)];
            if (mdBlocks.length === 0) {
              mdBlocks = [...output.matchAll(/```markdown\s*\n([\s\S]*?)```/g)];
            }
            const releaseBody = mdBlocks.length > 0
              ? mdBlocks[mdBlocks.length - 1][1].trim()
              : `_Could not generate notes._`;
            await github.rest.repos.createRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
              tag_name: '${{ needs.tag.outputs.new_tag }}',
              name: '${{ needs.tag.outputs.new_tag }}',
              body: releaseBody,
              draft: false,
              prerelease: false
            });
```

## How to install

```bash
# In your repo:
mkdir -p .github/jazz/workflows/release-notes .github/jazz/agents
$EDITOR .github/jazz/workflows/release-notes/WORKFLOW.md   # paste the WORKFLOW.md
$EDITOR .github/jazz/agents/release-notes.json             # see snippet below
$EDITOR .github/workflows/release.yml                      # paste the CI yaml
```

A minimal `release-notes.json` agent config:

```json
{
  "id": "release-notes",
  "name": "release-notes",
  "description": "Generates release notes from a tag range.",
  "model": "openai/gpt-4o-mini",
  "config": {
    "persona": "default",
    "llmProvider": "openai",
    "llmModel": "gpt-4o-mini",
    "tools": [
      "git_log",
      "git_diff",
      "read_file",
      "find",
      "find_path",
      "grep",
      "ls",
      "context_info",
      "summarize_context",
      "write_file"
    ]
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Add the secrets `OPENAI_API_KEY` and `RELEASE_PAT` in the repo settings, then trigger the action manually from the GitHub UI ("Run workflow" → choose patch/minor/major).

## How to customize

- **Different LLM** — change `llmProvider` / `llmModel` in the agent JSON. Anthropic, Google, xAI, OpenRouter, etc. all work; the matching `*_API_KEY` secret needs to be added.
- **Different tone** — edit step 5 in the WORKFLOW.md. We aim for "funny, exciting, product- and UX-focused"; you might want "boring, dry, minutes-of-meeting".
- **Group by type instead of feature** — change rule "Group by feature/product area, not by type" to its opposite. The rest of the recipe still works.
- **Skip the version bump** — drop the `tag` job and trigger the `release` job directly off `on: push: tags: ['v*']`.

## What you'll see

A new GitHub Release every time you dispatch the action, with a body like:

> ## What's Changed
>
> ### Workflow scheduling
> Jazz now catches up on workflows that missed their slot while your machine was asleep. ...
>
> ### CLI experience
> ...
>
> ## Commits
> - `3b9d4a5` feat(ci,cli): /jazz PR trigger; redact API keys ...

## Limits

- **Costs an LLM API key.** This is run-on-release, not run-on-every-commit, so cost is bounded.
- The "Bump version & create tag" job uses a `RELEASE_PAT` (Personal Access Token) so the push triggers downstream workflows. The default `GITHUB_TOKEN` cannot do that.
- The release body falls back to GitHub's auto-generated notes if Jazz can't produce a markdown block — see the `createRelease` script logic.

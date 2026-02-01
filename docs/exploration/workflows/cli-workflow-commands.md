# `jazz agent run <workflow>` — CLI Workflows Exploration

> Status: **Exploration / Design** — not implemented yet
>
> Goal: Define how `jazz agent run <workflow>` could provide reproducible, project-scoped workflows that feel like "agentic make targets" — including long-running (30–60+ min) jobs like deployments or deep research.

## 1. Concept & Goals

`jazz agent run <workflow>` is a thin CLI layer over three ideas:

1. **Named workflows** — reusable, declarative recipes for multi-step tasks.
2. **Project scope** — workflows live with your code / config and run in that context.
3. **Agent orchestration** — each workflow is executed *by* an agent, using tools, skills, and MCP.

The mental model:

- `jazz agent chat` → ad-hoc conversations.
- `jazz agent run` → **repeatable, named jobs** that can be:
  - Run interactively from the CLI.
  - Automated via CI, cron, or other tools.
  - Potentially run for 1h+ (deploys, investigations, deep research).

Examples:

- `jazz agent run release-notes`
- `jazz agent run inbox-triage`
- `jazz agent run todo-sweep`
- `jazz agent run data-sync --env staging`
- `jazz agent run deploy:patch --env staging`
- `jazz agent run deepresearch "agentic AI for incident response"`

## 2. UX & CLI Design

### 2.1 Basic commands

```bash
# List available workflows in current project + global
jazz agent workflows

# Run a workflow by name
jazz agent run <workflow-name> [<positional-args>...] [--agent <agent-id-or-name>] [--param key=value ...] [--auto-approve]

# Inspect a workflow definition
jazz agent workflow show <workflow-name>

# Dry-run: show plan but do not execute tools
jazz agent run <workflow-name> --dry-run
```

### 2.2 Resolution order

When the user runs `jazz agent run foo`:

1. Resolve the **current project root** (git root or cwd).
2. Search for workflow definitions in this order:
   - `./jazz.workflows.json` (project-scoped)
   - `./.jazz/workflows/*.json` (project-local storage)
   - `~/.jazz/workflows/*.json` (global user workflows)
3. Error clearly if the workflow is not found, and offer `jazz agent workflow create foo`.

This keeps workflows:

- **Discoverable** (`jazz agent workflows` shows a merged view).
- **Composable** (project + global workflows both available).
- **Portable** (JSON/YAML files can live in repo).

## 3. Workflow Definition Model

### 3.1 Minimal schema (exploratory)

```jsonc
{
  "name": "release-notes",
  "description": "Generate release notes from git history and open PRs.",
  "agent": "release-bot", // optional; falls back to default project agent
  "allowAutoApprove": true, // whether --auto-approve is allowed for this workflow
  "defaultApprovalProfile": "low-risk", // optional: read-only | low-risk | high-risk
  "params": {
    "from": { "type": "string", "required": false },
    "to": { "type": "string", "required": false }
  },
  "steps": [
    {
      "id": "collect-changes",
      "description": "Summarize commits between two refs",
      "prompt": "Generate a structured summary of all commits between {{from}} and {{to}}. Group by feature/fix/chore.",
      "tools": ["git"],
      "outputs": ["changes"]
    },
    {
      "id": "draft-notes",
      "description": "Draft human-readable release notes",
      "prompt": "Using {{changes}}, draft release notes in Markdown.",
      "tools": [],
      "outputs": ["release_notes_md"]
    },
    {
      "id": "write-file",
      "description": "Save release notes to file",
      "prompt": "Write {{release_notes_md}} to CHANGELOG.md, prepending to the file.",
      "tools": ["filesystem"],
      "requiresApproval": true
    }
  ]
}
```

Properties:

- `name` — workflow identifier used on CLI.
- `description` — human-readable summary for discovery.
- `agent` — optional explicit agent name/ID; if omitted, use default project agent.
- `allowAutoApprove` — whether this workflow may be run with `--auto-approve`.
- `defaultApprovalProfile` — optional hint for how strict auto-approval should be (`read-only`, `low-risk`, `high-risk`).
- `params` — named parameters that can be passed via `--param key=value` or via interactive prompts.
- `steps` — ordered list of **LLM+tools steps** executed by the agent.

Each step is *not* a low-level function, but a **prompt + tool sandbox**:

- `prompt` — instruction template with simple placeholders (`{{var}}`).
- `tools` — which Jazz tools / MCP servers are allowed in this step.
- `outputs` — names of artifacts to make available to later steps.
- `requiresApproval` — whether Jazz must present the plan/diff before executing any write.

### 3.2 Interactive parameters (prompted queries)

To support cases like `jazz agent run deepresearch` where the workflow needs a query, parameters can declare interactive prompts:

```jsonc
{
  "name": "deepresearch",
  "description": "Run a long-form deep research investigation.",
  "params": {
    "query": {
      "type": "string",
      "required": true,
      "prompt": "What should I research deeply?"
    },
    "timeframe": {
      "type": "string",
      "required": false,
      "default": "last 12 months"
    }
  },
  "steps": [ /* ... */ ]
}
```

CLI behavior:

- If the user **provides** a value:

  ```bash
  jazz agent run deepresearch --param query="agentic AI for incident response"
  # or positional shorthand
  jazz agent run deepresearch "agentic AI for incident response"
  ```

  → `query` is bound from CLI; no prompt.

- If the user **does not** provide a value:

  ```bash
  jazz agent run deepresearch
  ```

  → Jazz notices `query.required === true` and prompts interactively using the `prompt` text:

  ```text
  deepresearch requires a parameter:

  What should I research deeply?
  >
  ```

The bound parameter values (from CLI or prompts) then flow into step prompts via `{{query}}`, `{{timeframe}}`, etc.

### 3.3 Relationship to Agent Skills & MCP

Workflows are **meta-orchestration**, not a replacement for skills:

- A workflow step is like: "for this phase, use this agent, with these tools/skills enabled, to achieve X".
- Agent Skills handle *in-depth, domain-specific procedures* (e.g. release-notes skill, deepresearch skill).
- MCP provides access to external systems.

Recommended pattern:

- Workflows reference **skills by name** in prompts: e.g. "Use the `release-notes` skill to..." or "Use the `deepresearch` skill to run a full investigation".
- Agent configuration defines which skills and MCP servers are available.

## 4. Execution Model

### 4.1 High-level flow

When running `jazz agent run release-notes --param from=v1.2.0 --param to=v1.3.0` (or any other workflow, including long-running ones like `deploy:patch` or `deepresearch`):

1. **Load configuration**
   - Resolve project root.
   - Load `jazz.config.json` and agent definitions.
   - Load the matching workflow definition.

2. **Bind params & context**
   - Merge CLI params with defaults.
   - If required params are missing, prompt interactively using `params.*.prompt`.
   - Inject environment: cwd, repo info, etc.

3. **Plan & preview (optional)**
   - For `--dry-run`, render a synthetic plan:
     - Steps, tools, risky operations.
   - For normal runs, show a short summary and ask for confirmation if any step has `requiresApproval: true`.

4. **Step execution**
   - For each step in order:
     - Construct a system + user prompt that includes:
       - Step description & prompt text.
       - Available tools.
       - Relevant prior outputs.
       - Any applicable skills.
     - Allow the agent to call tools within the declared subset.
     - Capture structured outputs when requested (e.g. via JSON tool results, scratchpad, or explicit schema in future iterations).
     - Stream progress to the CLI (`[1/6]`, `[2/6]`, etc.) so long runs (30–60+ minutes) remain understandable.

5. **Safety checks**
   - For any tool call that writes state (files, git, email, HTTP with side-effects):
     - Reuse existing Jazz confirmation mechanism.
     - Surface *which step* initiated the action.
     - Optionally consult a **run-level approval policy** (see §5) when `--auto-approve` is used.

6. **Result reporting**
   - At the end, print a concise summary:
     - Which steps succeeded/failed.
     - Key artifacts (e.g. file paths, URLs, summaries).
     - A run ID for later inspection or partial re-runs.

### 4.2 Error handling & recovery

Exploration ideas:

- **Per-step retry policy**
  - e.g. `maxRetries`, `backoffMs`.
- **Skip vs. abort**
  - On failure, allow policy:
    - `abort` (default): stop workflow.
    - `continue`: skip to next step.
- **Partial re-run**
  - `jazz agent run release-notes --from-step draft-notes`.
  - `jazz agent run deploy:patch --from-step post-migration-checks`.
- **Run history**
  - Store run metadata (start/end time, status, params) per workflow to support inspection of long-running jobs.

These can be encoded in the workflow schema later if they prove useful.

## 5. Safety, Approvals & `--auto-approve`

`jazz agent run` must **inherit Jazz's safety model**:

- All state-changing tool calls still require explicit approval *unless* a safe, explicit auto-approval policy is in effect.
- Workflows **cannot silently escalate permissions**; they just structure calls the agent would make anyway.

### 5.1 Default behavior (no auto-approve)

By default (no flags):

- State-changing tool calls behave exactly like today:
  - Jazz prints the intent / diff.
  - User must confirm (Y/N).
- Workflows may batch multiple writes, but UX should:
  - Present a *grouped diff* per step.
  - Allow users to approve/deny step-by-step.

### 5.2 Run-level `--auto-approve`

For long-running workflows like `deepresearch`, `investigation`, or CI/CD deploys, users may want to approve once and let the workflow proceed without further prompts.

CLI:

```bash
# Read-mostly workflows (e.g. deepresearch)
jazz agent run deepresearch "agentic AI for incident response" --auto-approve

# Higher-risk workflows (e.g. deploy)
jazz agent run deploy:patch --env staging --auto-approve
```

Behavior:

1. Jazz checks the workflow definition:
   - If `allowAutoApprove !== true`, refuse and explain why.
2. Jazz still presents a **top-level confirmation** summarizing risks:

   ```text
   You are about to run workflow `deploy:patch` with auto-approve enabled.
   This may:
   - Run shell commands against: staging
   - Modify files and run git commands
   - Call external APIs with side effects

   Proceed? [y/N]
   ```

3. If approved, Jazz establishes a **run-level approval policy** derived from:
   - `defaultApprovalProfile` (e.g. `read-only`, `low-risk`, `high-risk`).
   - Potential user overrides or environment (e.g. CI vs. local).

4. During this run:
   - Per-tool confirmation checks consult the policy instead of always prompting.
   - High-risk actions can still be special-cased to require confirmation or be disallowed, depending on policy.

This gives:

- `deepresearch` / `investigation` workflows that can run for an hour without interaction.
- The option to run `deploy:patch` in CI with `--auto-approve`, but only if explicitly allowed.

## 6. Example Workflows

### 6.1 `todo-sweep`

Goal: Find TODO/FIXME comments in the repo, cluster them, and open a summary.

```jsonc
{
  "name": "todo-sweep",
  "description": "Scan the codebase for TODO/FIXME comments and summarize them.",
  "steps": [
    {
      "id": "scan",
      "description": "Scan repo for TODO/FIXME comments",
      "prompt": "Find all TODO and FIXME comments in the current repo. Group them by file and rough priority.",
      "tools": ["filesystem", "shell"],
      "outputs": ["todos"]
    },
    {
      "id": "summarize",
      "description": "Summarize TODOs into a Markdown report",
      "prompt": "Convert {{todos}} into a Markdown report grouped by file and priority.",
      "tools": [],
      "outputs": ["report_md"]
    },
    {
      "id": "save-report",
      "description": "Save report to docs/todos.md",
      "prompt": "Write {{report_md}} to docs/todos.md, creating the file if it does not exist.",
      "tools": ["filesystem"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run todo-sweep
```

### 6.2 `inbox-triage`

Goal: Triage yesterday's unread emails and create issues in the current repo when appropriate.

```jsonc
{
  "name": "inbox-triage",
  "description": "Triage yesterday's unread emails and create issues for actionable items.",
  "agent": "inbox-bot",
  "steps": [
    {
      "id": "fetch-emails",
      "description": "Fetch unread emails from the last 24h",
      "prompt": "Fetch and summarize all unread emails from the last 24 hours.",
      "tools": ["gmail"],
      "outputs": ["emails"]
    },
    {
      "id": "classify",
      "description": "Classify which emails are actionable for this repo",
      "prompt": "From {{emails}}, identify items that require changes or work in the current repo. Propose a list of GitHub issues to create.",
      "tools": [],
      "outputs": ["issues"]
    },
    {
      "id": "create-issues",
      "description": "Create GitHub issues for actionable items",
      "prompt": "Using {{issues}}, create issues in the current repo. Show a summary of issues before creating.",
      "tools": ["github"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run inbox-triage
```

### 6.3 `deepresearch`

Goal: Run a 30–60min deep research / investigation workflow using a dedicated **Agent Skill** (`deepresearch`) and web/MCP tools. The user can:

- Run it with an inline query, or
- Run it without a query and let Jazz prompt interactively.

```jsonc
{
  "name": "deepresearch",
  "description": "Run a long-form deep research investigation using the deepresearch skill.",
  "agent": "research-bot",
  "allowAutoApprove": true,
  "defaultApprovalProfile": "read-only",
  "params": {
    "query": {
      "type": "string",
      "required": true,
      "prompt": "What should I research deeply?"
    },
    "timeframe": {
      "type": "string",
      "required": false,
      "default": "last 12 months"
    }
  },
  "steps": [
    {
      "id": "deepresearch",
      "description": "Use the deepresearch skill to run a full investigation.",
      "prompt": "Use the `deepresearch` skill to perform a full, multi-phase investigation on: {{query}} (timeframe: {{timeframe}}). Summarize interim findings as you go, and produce a final structured report at the end.",
      "tools": ["web_search", "http", "filesystem"],
      "outputs": ["report_md"],
      "requiresApproval": false
    },
    {
      "id": "save-report",
      "description": "Save the research report to docs/deepresearch.md",
      "prompt": "Append {{report_md}} to docs/deepresearch.md with a clear timestamped heading.",
      "tools": ["filesystem"],
      "requiresApproval": true
    }
  ]
}
```

Run with inline query:

```bash
jazz agent run deepresearch "agentic AI for incident response"
```

Run and let Jazz prompt for the query, then auto-approve all read-only tool calls for this session:

```bash
jazz agent run deepresearch --auto-approve
```

Because `defaultApprovalProfile` is `read-only`, the run-level policy can automatically approve web searches, HTTP requests, and reads while still prompting for the final write to `docs/deepresearch.md` (due to `requiresApproval: true` on the save step).

### 6.4 `deploy:patch` (sketch)

Goal: Run a full patch deployment to a given environment. This is intentionally high-risk and should use a stricter approval profile.

Sketch only (details would depend on the specific stack):

```jsonc
{
  "name": "deploy:patch",
  "description": "Deploy the latest patch version to the specified environment.",
  "agent": "deploy-bot",
  "allowAutoApprove": true,
  "defaultApprovalProfile": "high-risk",
  "params": {
    "env": {
      "type": "string",
      "required": true,
      "prompt": "Which environment should I deploy to (e.g. staging, prod)?"
    }
  },
  "steps": [
    { "id": "status-checks", /* ... */ },
    { "id": "build-artifacts", /* ... */ },
    { "id": "run-migrations", /* ... */ },
    { "id": "deploy", /* ... */ },
    { "id": "post-checks", /* ... */ }
  ]
}
```

Run with:

```bash
jazz agent run deploy:patch --env staging
# or, in CI (trusted context):
jazz agent run deploy:patch --env staging --auto-approve
```

In this case, the `high-risk` approval profile might still require confirmation or disallow certain classes of operations when running locally, while allowing fully automated execution in CI where an explicit opt-in has been configured.

### 6.5 `investigation`

Goal: Run a full incident investigation / RCA workflow. This is a long-running job (often 30–60 minutes) that pulls logs and metrics, inspects code, and produces a structured report plus follow-up tasks.

High-level behavior:

- Accept an `incident_id` and optional `service` / `time_window`.
- Pull relevant logs and metrics from MCP-integrated systems.
- Correlate deploys, feature flags, errors, alerts.
- Inspect relevant code paths in the current repo.
- Produce a timeline, probable root causes, and recommended fixes.
- Create issues/tasks in the current repo or task system.

```jsonc
{
  "name": "investigation",
  "description": "Run a full incident investigation / RCA.",
  "agent": "ops-bot",
  "allowAutoApprove": true,
  "defaultApprovalProfile": "read-only",
  "params": {
    "incident_id": {
      "type": "string",
      "required": true,
      "prompt": "Which incident ID should I investigate?"
    },
    "service": {
      "type": "string",
      "required": false,
      "prompt": "Which service is primarily affected (optional)?"
    },
    "time_window": {
      "type": "string",
      "required": false,
      "default": "last 2 hours"
    }
  },
  "steps": [
    {
      "id": "gather-signals",
      "description": "Collect logs, metrics, and alerts for the incident window.",
      "prompt": "Using MCP-integrated observability tools (logs, metrics, alerts), collect data related to incident {{incident_id}} for {{time_window}}. Include any deploys or feature flag changes around that time.",
      "tools": ["mcp:logs", "mcp:metrics", "mcp:alerts"],
      "outputs": ["signals"],
      "requiresApproval": false
    },
    {
      "id": "correlate",
      "description": "Correlate signals and identify candidate root causes.",
      "prompt": "From {{signals}}, build a timeline of key events and propose candidate root causes with confidence scores.",
      "tools": [],
      "outputs": ["candidates", "timeline"],
      "requiresApproval": false
    },
    {
      "id": "code-analysis",
      "description": "Inspect relevant code paths in the current repo.",
      "prompt": "Using {{candidates}} and {{timeline}}, inspect the current repo for the most relevant code paths (handlers, jobs, services). Identify likely faulty code regions and suggest concrete fixes.",
      "tools": ["filesystem", "git"],
      "outputs": ["code_findings"],
      "requiresApproval": false
    },
    {
      "id": "draft-report",
      "description": "Draft a Markdown incident report.",
      "prompt": "Combine {{timeline}}, {{candidates}}, and {{code_findings}} into a structured incident report (Markdown) with sections: Summary, Impact, Timeline, Root Cause, Mitigations, Follow-up Tasks.",
      "tools": [],
      "outputs": ["report_md", "tasks"],
      "requiresApproval": false
    },
    {
      "id": "create-tasks",
      "description": "Create follow-up issues/tasks in the current repo or task system.",
      "prompt": "Using {{tasks}}, create issues in the current repository (and/or linked task system) for follow-up actions. Show a summary of issues before creating.",
      "tools": ["github"],
      "requiresApproval": true
    },
    {
      "id": "save-report",
      "description": "Save the incident report to docs/incidents.md.",
      "prompt": "Append {{report_md}} to docs/incidents.md under a new heading for incident {{incident_id}}.",
      "tools": ["filesystem"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run investigation --param incident_id=INC-1234
# or interactively (Jazz will prompt for incident_id)
jazz agent run investigation
```

`allowAutoApprove: true` + `defaultApprovalProfile: "read-only"` means log/metric collection and analysis can run without constant confirmations, while writes (issues, report files) still require explicit approval.

---

### 6.6 `refactor:api`

Goal: Safely perform a large-scale API rename / refactor across a repo or monorepo, with plan review, automated edits, test runs, and PR creation.

High-level behavior:

- Accept `from` and `to` symbols (e.g. method names) and optional `scope`.
- Scan the codebase for usages.
- Propose a refactor plan (grouped by package/module).
- Apply edits in small, reviewable chunks.
- Run tests.
- Create a branch + PR with a clear description.

```jsonc
{
  "name": "refactor:api",
  "description": "Safely perform a large-scale API rename across the repo.",
  "agent": "refactor-bot",
  "allowAutoApprove": false,
  "params": {
    "from": {
      "type": "string",
      "required": true,
      "prompt": "Which symbol/API should I replace (from)?"
    },
    "to": {
      "type": "string",
      "required": true,
      "prompt": "What should {{from}} be renamed to (to)?"
    },
    "scope": {
      "type": "string",
      "required": false,
      "prompt": "Optional: restrict to a subdirectory or package (leave blank for whole repo)."
    }
  },
  "steps": [
    {
      "id": "scan-usage",
      "description": "Scan the repo for usages of the old API.",
      "prompt": "Scan the current repo{{scope ? ` under ${scope}` : ''}} for usages of symbol {{from}}. Group results by file and package/module.",
      "tools": ["filesystem", "shell"],
      "outputs": ["usages"],
      "requiresApproval": false
    },
    {
      "id": "plan-refactor",
      "description": "Propose a structured refactor plan.",
      "prompt": "From {{usages}}, propose a structured refactor plan. Group by package/module and explain any risky areas.",
      "tools": [],
      "outputs": ["plan"],
      "requiresApproval": false
    },
    {
      "id": "apply-changes",
      "description": "Apply code changes according to the plan.",
      "prompt": "Apply the refactor plan {{plan}}: rename {{from}} to {{to}} across all affected files. Make conservative edits and prepare diffs for review.",
      "tools": ["filesystem"],
      "requiresApproval": true
    },
    {
      "id": "run-tests",
      "description": "Run tests to validate the refactor.",
      "prompt": "Run the project's test suite (or relevant subset if scope is set) and summarize results.",
      "tools": ["shell"],
      "outputs": ["test_results"],
      "requiresApproval": false
    },
    {
      "id": "create-pr",
      "description": "Create a branch and PR for the refactor.",
      "prompt": "Create a new branch and open a pull request summarizing the refactor from {{from}} to {{to}}. Include {{test_results}} in the PR description.",
      "tools": ["git", "github"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run refactor:api --param from=oldMethod --param to=newMethod
```

---

### 6.7 `release:ship`

Goal: Orchestrate an end-to-end release: collect changes, draft notes, bump versions, run tests/builds, create a tag/release, and prepare announcements.

High-level behavior:

- Accept a `version` (or infer next version).
- Collect commits/PRs since last tag.
- Use skills to generate structured changelog and human-readable notes.
- Bump version files.
- Run tests/builds.
- Create tag + release.
- Draft announcements (Slack/Notion/etc.).

```jsonc
{
  "name": "release:ship",
  "description": "End-to-end release orchestration for this project.",
  "agent": "release-bot",
  "allowAutoApprove": true,
  "defaultApprovalProfile": "low-risk",
  "params": {
    "version": {
      "type": "string",
      "required": false,
      "prompt": "Target version to release (leave blank to auto-suggest next)."
    }
  },
  "steps": [
    {
      "id": "collect-changes",
      "description": "Collect commits and PRs since last tag.",
      "prompt": "Collect commits and merged PRs since the last release tag. Group by feature/fix/chore.",
      "tools": ["git", "github"],
      "outputs": ["changes"],
      "requiresApproval": false
    },
    {
      "id": "draft-notes",
      "description": "Draft release notes using a release-notes skill.",
      "prompt": "Using the `release-notes` skill and {{changes}}, draft release notes in Markdown with sections for features, fixes, and chores.",
      "tools": [],
      "outputs": ["release_notes_md"],
      "requiresApproval": false
    },
    {
      "id": "bump-version",
      "description": "Bump version files/manifests.",
      "prompt": "Determine the target version (use {{version}} if provided, otherwise infer). Update relevant version files/manifests accordingly.",
      "tools": ["filesystem"],
      "requiresApproval": true
    },
    {
      "id": "run-tests-build",
      "description": "Run tests and build artifacts.",
      "prompt": "Run the full test suite and build release artifacts. Summarize any failures.",
      "tools": ["shell"],
      "outputs": ["test_results"],
      "requiresApproval": false
    },
    {
      "id": "tag-and-release",
      "description": "Create a git tag and remote release.",
      "prompt": "If tests passed, create a git tag for the new version and a release on the hosting platform with {{release_notes_md}} as the body.",
      "tools": ["git", "github"],
      "requiresApproval": true
    },
    {
      "id": "announce",
      "description": "Draft announcements for chat/docs.",
      "prompt": "Draft short announcements for Slack and Notion summarizing this release based on {{release_notes_md}} and {{test_results}}.",
      "tools": ["mcp:slack", "mcp:notion"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run release:ship --param version=1.4.0
# or interactively (Jazz will propose a version)
jazz agent run release:ship
```

---

### 6.8 `digest:week`

Goal: Generate a weekly engineering digest pulling from code, issues, docs, and CI, then publish it to files and/or chat/docs.

High-level behavior:

- Default timeframe: last 7 days.
- Collect:
  - Merged PRs, opened/closed issues.
  - Notion/doc updates.
  - CI incidents/failures.
  - Optionally key Slack threads.
- Group by team/project/repo.
- Output a Markdown digest and optionally post to Slack/Notion.

```jsonc
{
  "name": "digest:week",
  "description": "Generate a weekly engineering digest.",
  "agent": "digest-bot",
  "allowAutoApprove": true,
  "defaultApprovalProfile": "read-only",
  "params": {
    "from": {
      "type": "string",
      "required": false,
      "default": "7 days ago"
    },
    "to": {
      "type": "string",
      "required": false,
      "default": "now"
    }
  },
  "steps": [
    {
      "id": "gather-events",
      "description": "Gather events from code, issues, docs, and CI.",
      "prompt": "Between {{from}} and {{to}}, collect: merged PRs, opened/closed issues, doc updates, and notable CI incidents for this project/org.",
      "tools": ["github", "mcp:notion", "mcp:ci"],
      "outputs": ["events"],
      "requiresApproval": false
    },
    {
      "id": "group-events",
      "description": "Group events by team/project and significance.",
      "prompt": "Group {{events}} by team/project/repo. Highlight high-impact changes and notable incidents.",
      "tools": [],
      "outputs": ["grouped_events"],
      "requiresApproval": false
    },
    {
      "id": "draft-digest",
      "description": "Draft a Markdown weekly digest.",
      "prompt": "Draft a Markdown weekly digest based on {{grouped_events}}. Include sections for Highlights, Changes by Area, and Incidents.",
      "tools": [],
      "outputs": ["digest_md"],
      "requiresApproval": false
    },
    {
      "id": "publish",
      "description": "Publish the digest to docs and chat.",
      "prompt": "Append {{digest_md}} to docs/digest-weekly.md with a new heading, and draft a brief announcement for Slack.",
      "tools": ["filesystem", "mcp:slack"],
      "requiresApproval": true
    }
  ]
}
```

Run with:

```bash
jazz agent run digest:week
```

Because this workflow is mostly read-only until the final publish step, `allowAutoApprove: true` + `defaultApprovalProfile: "read-only"` allows it to collect and analyze data without bothering the user, while still requiring confirmation before writing files or posting announcements.

---

## 7. Open Questions

- **Schema expressiveness vs. complexity**
  - How far do we go before this becomes its own DSL? Start minimal.
- **Result typing**
  - Should `outputs` be untyped blobs, or do we want optional JSON schemas per output?
- **Skill discovery**
  - Should workflows declare required skills explicitly, or rely on agents' existing skill sets?
- **Caching & idempotency**
  - Do we want first-class support for caching expensive steps and reusing results across runs?
- **Telemetry**
  - How to record workflow runs (success/failure, duration, costs) in a way that's easy to inspect from the CLI?
- **Approval profiles**
  - How granular should `defaultApprovalProfile` be, and how does it interact with environment (local vs CI)?

## 8. Next Steps (if we decide to build this)

1. Implement a **minimal JSON workflow loader** + `jazz agent workflows` / `jazz agent run` that:
   - Finds `jazz.workflows.json`.
   - Supports a single-step workflow with a prompt and tool subset.
   - Reuses existing agent execution & approval mechanisms.

2. Add parameter prompting based on `params` metadata and basic `--param` / positional argument binding.

3. Add a simple run-level approval policy object and a `--auto-approve` flag, gated by `allowAutoApprove`.

4. Iterate on schema based on real examples (release notes, todo sweep, inbox triage, deepresearch, deploy:patch).

5. Integrate with existing exploration docs in `agent-orchestration/` and `workflows/` to ensure concepts stay aligned.

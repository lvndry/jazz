# research-digest

**What it does:** Once a week, picks up where you left off on a topic of your choice (e.g. "agentic LLM systems"), runs a multi-source search, synthesizes the new-this-week material, and writes a markdown digest to disk.
**Schedule:** `0 8 * * 0` — 08:00 every Sunday.
**Risk:** `read-only` — only `web_search`, `http_request`, and a single `write_file`.
**Tools used:** `web_search`, `http_request`, `defuddle` skill (clean text extraction), `digest` skill (output formatting), optional `obsidian` skill, `write_file`.

## Why this is useful

The discipline of "read about $TOPIC every week" survives about three weeks unaided. This recipe survives indefinitely because the friction is zero and the output is grep-able. Over a year you accumulate ~52 short, dated notes you can search for "when did this become A Thing".

## The workflow file

```markdown
---
name: research-digest
description: Weekly digest on a chosen topic — papers, posts, releases.
schedule: "0 8 * * 0"
autoApprove: read-only
catchUpOnStartup: true
maxCatchUpAge: 604800
maxIterations: 60
skills:
  - deep-research
  - defuddle
  - digest
---

# Weekly Research Digest

Topic: **agentic LLM systems and tooling**

(Edit the topic above to whatever you actually want to track. One topic per workflow file. Clone the workflow under different names for different topics.)

## Step 1 — Constraints

- Window: items published in the last 7 days.
- Sources, in this order of preference:
  1. arXiv (cs.AI, cs.LG, cs.CL)
  2. Hugging Face daily papers
  3. Anthropic / OpenAI / Google / DeepMind / Meta AI research blogs
  4. Hacker News front page (mentioning the topic)
  5. r/MachineLearning top-of-week
  6. Notable individual blogs (Sebastian Raschka, Simon Willison, Lilian Weng, etc.)
  7. Open-source releases on GitHub trending

Skip clickbait aggregators and re-posts.

## Step 2 — Search

Use the `web_search` tool with `depth: deep` and a 7-day `fromDate`. Run 3–5 distinct queries to triangulate:

- The topic verbatim
- The topic + "paper" / "release" / "tool"
- 1–2 reformulations using a sub-aspect of the topic

Cap at 30 candidate items.

## Step 3 — Read

For each candidate URL, fetch with `http_request`, run through `defuddle` to get clean main text, and judge:

- Is this actually new (published in window)? Skip if not.
- Is this actually about the topic, not just keyword-matching?
- Is the source trustworthy enough to cite?

Keep the 8–15 strongest items. Diversity beats volume — don't cite five blog posts about the same paper.

## Step 4 — Write

Use the `digest` skill's format. Save to `$HOME/research-digest/<topic-slug>/<YYYY-MM-DD>.md` where `<topic-slug>` is the kebab-cased topic (e.g. `agentic-llm-systems`).

Layout:

```markdown
# <Topic> — Week of <YYYY-MM-DD>

## TL;DR
[3–5 bullets capturing the week. Skip if quiet.]

## Papers
- **<title>**
  <one-line takeaway>
  Authors · Venue/Year · <url>

## Posts & releases
- **<title>**
  <one-line summary>
  Source: <site> · <url>

## Open source
- **<repo>** — <one-line>
  <url>

## What I'd read first
[Pick one item, say why.]

## Sources
[Every URL fetched, for traceability.]
```

If the week was genuinely quiet, write `Quiet week. <2 sentences on what's *not* happening>.`

## Rules

- Read-only on the web. Never POST anywhere.
- Always include the URL on every item.
- Skip anything you cannot verify is actually from the last 7 days.
- Do not invent items. If you can't find 8, write fewer.
```

## How to install

```bash
# 1. Confirm a search provider is configured
jazz config show | grep -i search
# If none, configure one (see https://docs.jazz.ai or run /config in chat).
# Cheapest options: Brave (free tier), Tavily (free tier).
# Premium: Exa, Perplexity, Parallel.

# 2. Drop in the workflow (or copy + rename per topic)
mkdir -p ~/.jazz/workflows/research-digest
$EDITOR ~/.jazz/workflows/research-digest/WORKFLOW.md   # paste, edit the topic

# 3. Run once foreground
jazz workflow run research-digest

# 4. Schedule
jazz workflow schedule research-digest
```

## How to customize

- **Multiple topics** — clone the workflow:
  ```bash
  cp -r ~/.jazz/workflows/research-digest ~/.jazz/workflows/research-digest-rust-async
  $EDITOR ~/.jazz/workflows/research-digest-rust-async/WORKFLOW.md
  # Change `name:` and the "Topic:" line, schedule on a different day
  jazz workflow schedule research-digest-rust-async
  ```
- **Save to Obsidian** — uncomment the `obsidian` skill in `skills:` and replace Step 4's path with `Research/<topic>/Week of <YYYY-MM-DD>.md`. Use `obsidian create path=...` (don't overwrite).
- **Daily, not weekly** — tighten the window in Step 1 to 24h and change `schedule` to `0 8 * * *`. Cap to 5 items so you actually read them.
- **Different output style** — the recipe pulls in the `digest` skill, which already enforces a "headline + one line + source" template. If you want long-form, drop `digest` from the skills list and ask in the prompt.

## What you'll see

A small markdown file per week per topic, e.g. `~/research-digest/agentic-llm-systems/2026-04-26.md`. After eight weeks the directory listing alone is a research log. You can search it with ripgrep:

```bash
rg --files-with-matches "MoE" ~/research-digest/
```

## Limits

- **Costs depend on your search provider.** Brave and Tavily have free tiers; Exa, Perplexity, and Parallel are paid. The recipe runs 3–5 queries plus ~30 page fetches per week — well within free tiers for one or two topics.
- The `defuddle` skill handles most blogs but won't beat strict bot-detection. The recipe surfaces those URLs anyway and notes that they were unreadable.
- The agent's decision of "is this actually about the topic" is judgemental — that's the point. If you find it citing the wrong things, tighten the "Sub-questions" or sources list in the prompt.

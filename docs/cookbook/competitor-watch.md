# competitor-watch

**What it does:** Once a week, fetches the public blog/changelog/release feeds of competitors you list, summarizes what changed, and writes the digest into your Obsidian vault (or a plain folder if you don't use Obsidian).
**Schedule:** `0 9 * * 1` — 09:00 every Monday.
**Risk:** `low-risk` — fetches HTTP, writes a single new file. Never overwrites your notes.
**Tools used:** `web_search` (Brave/Tavily/Exa/Perplexity/Parallel — whichever you have configured), `http_request`, `defuddle` skill (for clean text extraction), `obsidian` skill (optional), `write_file`.

## Why this is useful

Knowing what your competitors shipped last week is most of the work of competitive analysis, and almost nobody actually does it weekly because reading a dozen blogs is boring. This recipe is the boring part automated. The interesting part — what it means for your roadmap — stays human.

## The workflow file

```markdown
---
name: competitor-watch
description: Weekly competitor changelog/blog digest, written to Obsidian.
schedule: "0 9 * * 1"
autoApprove: low-risk
catchUpOnStartup: true
maxCatchUpAge: 604800
maxIterations: 80
skills:
  - defuddle
  - digest
  - obsidian
---

# Competitor Watch — Weekly Digest

You are building a weekly digest of what my competitors shipped or said publicly in the last 7 days.

## Competitors

Edit this block to whatever you actually care about. Each entry is `name | homepage | feed/changelog URL (optional)`.

- Acme AI | https://acme.ai | https://acme.ai/changelog
- Foo Labs | https://foo.dev | https://foo.dev/blog/feed.xml
- BarCorp | https://barcorp.com |

If a feed URL is empty, fall back to a `web_search` for `site:<homepage> after:<7 days ago>`.

## Step 1 — Collect

For each competitor:

1. If a feed URL is provided, `http_request` it. Parse the items dated within the last 7 days. Keep title, URL, date.
2. If no feed URL, use `web_search` with `site:<homepage>` and a 7-day `fromDate`.
3. For each item URL, fetch the page (`http_request`) and use the `defuddle` skill to strip nav/ads/junk down to clean main content.

Cap each competitor at the 5 most recent items.

## Step 2 — Summarize

For each item, extract:

- **What** — one sentence on what was announced.
- **Why it matters** — one sentence on the implication. Be honest. "Probably nothing" is a valid answer.
- **Tag** — one of: `product`, `pricing`, `funding`, `hiring`, `partnership`, `blog`, `other`.

## Step 3 — Write the digest

Use this template, save to my Obsidian vault if `obsidian` is reachable, otherwise save to `$HOME/competitor-watch/<YYYY>/<MM>/week-of-<YYYY-MM-DD>.md` (the Monday of the week).

If using Obsidian: target path `Competitive/Weekly/Week of <YYYY-MM-DD>.md`. Use `obsidian create path=...` (do not overwrite if it exists — append a numeric suffix).

```markdown
# Competitor Watch — Week of <YYYY-MM-DD>

## Headlines
[3–5 bullets summarizing the week across competitors. Skip if quiet.]

## <Competitor name>
- **<Item title>** [<tag>]
  What: <one sentence>
  Why it matters: <one sentence>
  Source: <url> · <date>

## <Next competitor>
- ...

## Quiet this week
[List any competitors with zero items.]

## Sources
[Bullet list of every URL fetched, for traceability.]
```

## Rules

- Don't invent items. If `http_request` returns 4xx/5xx for a feed, log it under a `## Errors` section and skip that competitor.
- Don't editorialize beyond "Why it matters". One sentence is enough.
- Read-only on the web. Never POST anywhere.
- Never overwrite an existing weekly file — suffix `-2`, `-3`, etc.
```

## How to install

```bash
# 1. Make sure web_search is configured. Pick one provider:
jazz config show | grep -i webSearch
# or set it through the chat with: /config

# 2. (Optional) make sure Obsidian is running and the CLI is enabled
#    (Settings → General → Command line interface)
which obsidian || echo "Obsidian CLI not found — recipe will fall back to plain files"

# 3. Drop in the workflow
mkdir -p ~/.jazz/workflows/competitor-watch
$EDITOR ~/.jazz/workflows/competitor-watch/WORKFLOW.md  # paste, then edit the competitor list

# 4. Dry run
jazz workflow run competitor-watch

# 5. Schedule
jazz workflow schedule competitor-watch
```

## How to customize

- **More frequent** — change `schedule` to `0 9 * * 1,4` (Mon and Thu).
- **No Obsidian** — remove `obsidian` from the `skills:` list and delete the Obsidian branch in Step 3. The fallback path under `$HOME/competitor-watch/` is already there.
- **Notion instead of Obsidian** — install the upstream Notion MCP server (`npx -y mcp-remote https://mcp.notion.com/mcp` or [makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server)), wire it into Jazz with `jazz mcp add`, then ask the workflow to write the page via the Notion MCP tool. Jazz does **not** ship a Notion integration on its own.
- **Changelog-only mode** — drop the homepage scraping step and require a feed URL for each competitor. Cleaner, less noise.

## What you'll see

A new note every Monday with one section per competitor and a short headline section. Over time the `Competitive/Weekly/` folder becomes a searchable archive of how each competitor moved.

## Limits

- **Costs an API key for the search provider.** Brave and Tavily have free tiers. Exa, Perplexity, and Parallel are paid. Pick one and set it in your Jazz config.
- Some competitor sites block scrapers. The `defuddle` skill handles most blogs but won't beat a Cloudflare challenge — the recipe will skip those and surface them under `## Errors`.
- The Obsidian skill talks to a running Obsidian app via IPC. If the app isn't open when the workflow fires, the fallback file path is used.

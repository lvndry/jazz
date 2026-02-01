---
name: digest
description: Build news or topic digests using curated high-quality sources. Use when the user wants tech news, a digest, "what's new in X", daily or weekly roundup, research papers roundup, or news from trusted sources only.
---

# Digest

Build short digests (tech news, topics, roundups) using **curated best sources** only. Quality over quantity; no clickbait or low-signal outlets.

## When to Use

- User wants tech news, a digest, or "what's new"
- User asks for a daily or weekly roundup on a topic
- User wants news from "good sources" or "trusted sources"
- User says "tech news", "dev news", "AI news", "what's happening in X"
- User wants **research papers** on a topic (recent papers, key papers, paper digest)

## Core Rule: Use Best Sources Only

**Always prefer the curated source list.** When searching or building a digest:

1. **Search within preferred sources first** (e.g. `site:arstechnica.com`, `site:news.ycombinator.com`, or explicit queries that name these outlets).
2. **Include source name** on every item so the user knows where it's from.
3. **Skip** generic aggregators, clickbait, and low-signal sources unless the user explicitly asks for a specific outlet.

For the full list of preferred sources by topic, see [references/sources.md](references/sources.md).

## Digest Format

```markdown
# [Topic] Digest — [Date or "Latest"]

## Headlines

### [Optional: Sub-topic or category]

- **[Headline]**  
  [One-line summary or key takeaway.]  
  Source: [Source name] · [URL]

- **[Headline]**  
  [One-line summary.]  
  Source: [Source name] · [URL]

### [Next sub-topic]

- ...

## Summary
[Optional: 2–3 sentence wrap-up or "what matters most" if useful.]
```

Keep each item to: headline + one line + source + link. No long summaries unless the user asks for "deep dive" or "explain".

### Including Research Papers

When the digest includes papers, use the **Research Papers** sources (arXiv, Semantic Scholar, Papers with Code, OpenReview, etc.). Format each paper as:

```markdown
- **[Paper title]**  
  [One-line summary or key result.]  
  Authors · Venue/Year · [URL]
```

Example: **Attention Is All You Need** — Transformer architecture. Vaswani et al. · NeurIPS 2017 · [link]

## Workflow

1. **Clarify topic and scope**: Tech? AI? Papers? **Time frame** — Did the user specify one (e.g. this week, 2024)? If not, use most recent.
2. **Choose sources**: Use only sources from the curated list for that topic. For papers use arXiv, Semantic Scholar, Papers with Code, OpenReview, etc.
3. **Gather**: Search or fetch from those sources (web search with site limits or known feeds).
4. **Select**: Pick the most relevant 5–15 items; avoid duplicate stories.
5. **Format**: Use the digest template above; always cite source and link.

## Time Awareness

**Respect the user's time frame when given.** If none is given, use the **most recent** information on the topic.

1. **User specifies a time frame** → Use only content from that period.
   - Examples: "this week", "last month", "2024", "January", "past 3 days", "recent papers from 2023"
   - In queries: add date filters, year, or "since X" so results match the requested window.
2. **No time frame given** → Default to **most recent**.
   - News: last few days (e.g. 24–72 hours).
   - Papers: latest preprints and recent conference/journal (e.g. current and previous year unless topic is historical).
   - Don't assume "all time"; prefer recent unless the user asks for "history" or "overview since X".

Always state the time scope in the digest header (e.g. "Tech Digest — This week" or "Latest") so the user knows what window was used.

### Time Scope Reference

| User says / implies                    | Window to use               |
| -------------------------------------- | --------------------------- |
| today, latest, recent, "what's new"    | Last 24–72 hours            |
| this week                              | Last 7 days                 |
| this month                             | Last 30 days                |
| last month                             | Previous calendar month     |
| 2024, "in 2024"                        | That year                   |
| "papers from 2023"                     | That year                   |
| no time given                          | Most recent (see above)     |
| "historical", "overview", "since 2020" | Per user; can include older |

## What to Avoid

- **Don't** use random or low-quality sources just to fill the digest.
- **Don't** include items without a clear source and link.
- **Don't** copy full article text; one-line summary max unless user asks for more.
- **Don't** mix in uncurated "news" from social or unknown sites unless the user asked for it.

## Optional: User Preferences

If the user says they prefer certain outlets or want to exclude something (e.g. "no crypto"), apply that on top of the curated list. The curated list is the baseline; user overrides narrow it further.

## Anti-Patterns

- ❌ Digest with no source names or links
- ❌ Dozens of items from random sites
- ❌ Long paragraphs per item (keep it scannable)
- ❌ Including sources not in the curated list without user request
- ❌ Ignoring user time frame (e.g. "this week" but including month-old items)
- ❌ Defaulting to "all time" when no time given; use most recent instead

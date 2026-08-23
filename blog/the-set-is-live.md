---
title: "The set is live"
description: "Jazz has a website. Here's what it is, what it deliberately isn't, and why the repo is the CMS."
date: 2026-08-23
---

Jazz has a website. If you're reading this on it, scroll the
[homepage](/) once — the room reacts to your cursor, a real session plays
itself, and an approval card lands and then holds perfectly still. That
stillness is the point, but more on that in a future post.

A few decisions worth writing down, because they'll shape everything that
lands here later.

## The repo is the CMS

Every docs page on this site is rendered straight from the markdown in
[`docs/`](https://github.com/lvndry/jazz/tree/main/docs) — nothing is
copied, nothing can drift. Edit a doc, the site rebuilds. This post lives in
a `blog/` folder in the same repository, next to the code it talks about.

The same rule goes deeper than content. The site's colors are generated from
the CLI's own [`theme.ts`](https://github.com/lvndry/jazz/blob/main/src/cli/ui/theme.ts):
the cyan on the homepage is xterm index 45, byte-identical to what you see
over SSH. The activity indicator in the hero runs the terminal's actual
spec — five lanes on pairwise-coprime periods, so the pattern doesn't repeat
for about thirteen minutes. Nothing on the site is an illustration of the
product; it's the product's own parts, enlarged.

## Machines are an audience too

Every docs page is also served raw: append `.md` to any docs URL, or start
from [/llms.txt](/llms.txt). If your agent wants to read about Jazz, it
shouldn't have to scrape HTML.

## What's next here

This blog is where the internals essays will land — how the approval
round-trip travels from a server to your thumb, what context compaction
actually does at 80%, and what we learn measuring agents on everyday work
rather than code. One post per real capability, no cadence theater.

Subscribe via [RSS](/rss.xml), or start with the
[quick start](/docs/guide/quick-start) — the free path needs no card:

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
```

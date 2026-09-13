---
name: price-watch
description: Check the prices of a few things you want, remember them, and report only what moved since last time.
schedule: "0 8 * * *"
autoApprove: low-risk
maxIterations: 30
maxCostUSD: 0.40
author: jazz
tags: [shopping, web, personal]
---

# Price watch

Check the prices below and tell me only what changed. You may read the web and update your
memory; do not buy, sign in, or fill any form.

## Watch

Edit this list. One line each: what it is, the page to check, and the price I would pay.

- Example headphones, https://example.com/product/123, buy under 180 EUR
- Example flight Paris to Lisbon in October, https://example.com/flights?..., buy under 90 EUR

## Check

For each line, open the page and read the current price and currency. If the page needs a login
or blocks you, record "unavailable" for that item and move on; do not retry more than once.

## Remember

Keep one memory entry per item, keyed by its URL, holding the last price seen and when. Before
writing, read the previous entry so you can compare. This is the only thing you write.

## Report

Reply with one line per item that changed or crossed its target since `{schedule.lastRunAt}`:
name, old price, new price, and whether it is now under my target. End with one line for the
items that did not move, comma separated, and one line for anything unavailable.

If nothing changed at all, reply with exactly "No price changes." and stop.

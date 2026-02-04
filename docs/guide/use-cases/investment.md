# Use Case: Weekly Investment Report

## Overview

Receive a consolidated report on market trends and specific assets every week.

## Prerequisites

- **Jazz CLI**.
- **Investment Analysis** skill (if custom) or standard **Research** tools.

## Setup

1. **Create Workflow**: `market-report.workflow.md`

   ```markdown
   # Weekly Market Report

   1. Get the current price and 7-day trend for: BTC, ETH, SPY, QQQ.
   2. Search for "major crypto regulation news last week" and "macroeconomic announcements US last week".
   3. Summarize the sentiment for both Crypto and Tech stocks.
   4. Create a markdown report in `personal/finance/reports/YYYY-MM-DD.md`.
   ```

2. **Schedule**:
   ```bash
   jazz workflow schedule market-report --cron "0 8 * * 1"
   ```

## Outcome

Every Monday morning, you have a fresh market dossier waiting for you.

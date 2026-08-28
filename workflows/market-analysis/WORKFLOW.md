---
name: market-analysis
description: Daily comprehensive stock market and crypto analysis with investment insights
schedule: "0 6 * * *"
autoApprove: true
catchUpOnStartup: true
maxCatchUpAge: 43200
skills:
  - deep-research
---

# Daily Market Analysis

Comprehensive daily analysis across global equities, crypto, and macro — with the discipline to look past the day's tape to the policy and structural forces that move capital over quarters. **Cover the world, not just the US, and favor durable second-order effects over headline ticks.**

## Analysis Scope

### 1. Major Indices & ETFs
**US:**
- S&P 500 (SPY), NASDAQ (QQQ), Dow Jones (DIA), Russell 2000 (IWM)
- VIX; sector ETFs: XLF, XLE, XLK, XLV

**Global:**
- Europe: STOXX 600, DAX, CAC 40, FTSE 100
- Asia-Pacific: Nikkei 225, Hang Seng, CSI 300, KOSPI, ASX 200, Nifty 50 / Sensex
- Americas ex-US: Ibovespa, TSX
- EM basket: MSCI Emerging Markets (EEM)
- Cross-assets: DXY, US 10Y, gold, Brent/WTI, copper

### 2. Individual Stocks
- US: AAPL, MSFT, GOOGL, AMZN, META, NVDA; TSLA, RIVN, LCID; AMD, PLTR, C3.AI
- International: ASML, TSM, SAP, Tencent, Nestlé, LVMH, Toyota, Samsung, Reliance
- For any theme (AI, energy, defense, semis, luxury), pull the global leaders — not only US tickers

### 3. Cryptocurrencies
- Bitcoin (BTC): price, dominance, Fear & Greed, on-chain flows
- Ethereum (ETH): network activity, gas, DeFi trends

### 4. Economic Indicators (global)
- Data across regions: US, Eurozone, UK, China, Japan, India, Brazil
- Central banks beyond the Fed: ECB, BOE, BOJ, PBOC, RBI, BCB, EM policy
- FX/rates: DXY, US 10Y, bund spreads, EM carry

### 5. Policy, Politics & Long-Term Structurals

The differentiator. Trace each major development — a law passed, a central-bank path, an election, a CEO announcement, or a deal (e.g. a gold miner being acquired) — to its **second-order, multi-quarter consequences**, not the intraday reaction.

- **What changed**: the specific event and why it matters
- **Who is structurally helped/hurt**: sectors, asset classes, geographies, business models — and the mechanism (margins, capex, rates, demand, supply chains)
- **Horizon**: when it bites (next print vs 1–4+ quarters) and whether it's priced in
- **Thesis impact**: how it upgrades/downgrades or rotates the 12-month view
- **Decisions it forces**: the durable choices it pushes — add/trim exposure, open a watchlist item, rotate capital, revisit a thesis. State them as decisions, not observations.
- **Regime vs headline**: a durable shift (policy regime, fiscal path, geopolitical realignment, industry consolidation) vs a one-off print. A single data point is not a trend.
- **Sources**: primary/long-form (central-bank statements, legislation, filings, deep analysis) over wire snippets and social takes

## Research Sources

- Real-time: Yahoo Finance, Google Finance, TradingView
- News: Bloomberg, Reuters, CNBC, FT, WSJ
- Sentiment: X/FinTwit, Reddit (r/stocks, r/wallstreetbets)
- Analysis: Seeking Alpha, Benzinga, MarketWatch
- Crypto: CoinGecko, CoinMarketCap, Glassnode
- Policy/primary: central-bank statements, legislation & regulatory filings, budget documents
- International: regional outlets (Nikkei, Handelsblatt, Caixin, Economic Times, Valor) — not the US wire alone

## Analysis Framework

For each asset:

1. **Price Action** (24h / 1w / 1m): price, % change, support/resistance, volume vs average
2. **Technical**: trend, RSI, 50/200MA, MACD
3. **News & Catalysts**: earnings, regulation, upcoming catalysts
4. **Sentiment**: social, institutional flow, options flow
5. **Investment Thesis**: bull/bear case, BUY/HOLD/SELL/WAIT with confidence
6. **Policy & Political Impact**: for each major event, what changed, who wins/loses, horizon, thesis impact, and the decision it forces. Name regime-shift vs one-off before it moves a call.

## Output Format

Save to `$HOME/market-analysis/YYYY/MM/DD.md`:

```markdown
# Market Analysis - [Date]
**Generated**: [ISO timestamp] | **Market Status**: [Open/Closed, Pre-market if 6 AM]

## 📊 Executive Summary
[2-3 sentences: bias and key drivers]
**Quick Take:** ✅ Buy: […] 🔶 Hold: […] ⚠️ Avoid: […]

## 🏛️ Major Indices (US)
[S&P/NASDAQ/Dow/Russell + VIX; sector best/worst]

## 🌍 Global Markets
- Europe: [move + driver]
- Asia-Pacific: [move + driver]
- Americas ex-US: [move + driver]
- EM & cross-assets: [EEM, DXY, 10Y, gold, oil, copper — what's repricing]
- Global flow note: [capital rotation; what a non-US event means for US positioning]

## 💼 Individual Stocks
[Per name: price, technical, news, sentiment, verdict]

## ₿ Cryptocurrencies
[Per coin: price, dominance, on-chain, verdict]

## 📈 Technical Market Overview
[Breadth, volume, VIX, put/call]

## 📰 Key News & Events
[Top 3-5, with impact]

## 🔮 Today's Outlook
[Direction, levels, events today]

## 🏛️ Policy & Long-Term Impact
For each major event:
- What changed: [event]
- Second-order effects: [who's helped/hurt, 1–4+ quarters]
- Thesis impact: [12-month re-weight]
- Decisions it forces: [add/trim/rotate/watch, revisit thesis]
- Regime vs headline: [durable or one-off]

## 💡 Investment Recommendations
🟢 Top Buy / 🟡 Watch / 🔴 Avoid — with catalyst and risk/reward

## ⚠️ Risk Factors
[2-3: policy, geopolitics, earnings]

**Disclaimer**: Informational only, not financial advice.
**Data Sources**: […] | **Analysis Time**: ~[X] min
```

## Research Quality Standards

- Verify prices across sources; explain *why* moves happen
- Actionable targets when possible; balanced bull/bear
- Separate durable regime change from intraday noise

## Special Instructions

1. Pre-market focus at 6 AM; weekends analyze Friday + preview Monday
2. Crypto 24/7; flag overnight gaps
3. Confidence levels on calls; always state risk/reward
4. **Long-term lens**: before any call, name the policy/political shift that changes the 12-month thesis — not today's print
5. **Global**: cover non-US indices, central banks, and companies; capital rotates across regions

## What NOT to Do

- ❌ Prices without context, or predictions without evidence
- ❌ Penny/meme stocks without disclaimers; overly bullish/bearish
- ❌ Anchor on headline tickers — read the structural shift first
- ❌ US-only framing — this is a world market report

## Advanced Analysis (when relevant)

Correlation, seasonality, institutional flows, global context, futures, and policy second-order mapping (event → sectors/names helped/hurt → horizon).

## Error Handling

If data is missing: note it, use last known with timestamp, lower confidence.

**Goal**: actionable, objective analysis that looks past the tape to the global, structural forces that compound over quarters.

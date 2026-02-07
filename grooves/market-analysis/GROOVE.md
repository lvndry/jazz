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

Perform comprehensive market analysis covering major indices, individual stocks, and cryptocurrencies. Provide actionable insights for investment decisions.

## Analysis Scope

### 1. Major Indices & ETFs
- **S&P 500 (SPY)**: Overall market health, sector performance
- **NASDAQ (QQQ)**: Tech sector trends
- **Dow Jones (DIA)**: Industrial strength
- **Russell 2000 (IWM)**: Small-cap performance
- **VIX**: Market volatility and fear index
- **Sector ETFs**: XLF (financials), XLE (energy), XLK (tech), XLV (healthcare)

### 2. Individual Stocks
- **Tech Giants**: AAPL, MSFT, GOOGL, AMZN, META, NVDA
- **EV & Innovation**: TSLA, RIVN, LCID
- **AI Leaders**: NVDA, AMD, PLTR, C3.AI
- **Others**: Add any stocks you're tracking or considering

### 3. Cryptocurrencies
- **Bitcoin (BTC)**: Price action, on-chain metrics, dominance
- **Ethereum (ETH)**: Network activity, gas fees, DeFi trends
- **Market Sentiment**: Fear & Greed Index, institutional flows

### 4. Economic Indicators
- Recent economic data releases (GDP, inflation, employment)
- Fed policy signals and interest rate expectations
- Global macro events (geopolitics, central bank moves)

## Research Sources

Use these sources for comprehensive analysis:
- **Real-time data**: Yahoo Finance, Google Finance, TradingView
- **News**: Bloomberg, Reuters, CNBC, Financial Times, WSJ
- **Sentiment**: Twitter/X (FinTwit), Reddit (r/wallstreetbets, r/stocks)
- **Analysis**: Seeking Alpha, Benzinga, MarketWatch
- **Crypto**: CoinGecko, CoinMarketCap, Glassnode, LookIntoBitcoin
- **Technical**: TradingView charts, volume analysis
- **On-chain**: Blockchain explorers, whale tracking

## Analysis Framework

For each asset, provide:

1. **Price Action** (Last 24h, 1 week, 1 month)
   - Current price, % change
   - Key support/resistance levels
   - Volume analysis (above/below average?)

2. **Technical Indicators**
   - Trend: Uptrend, downtrend, or consolidation
   - RSI: Overbought (>70), oversold (<30), or neutral
   - Moving averages: Above/below 50-day and 200-day MA
   - MACD: Bullish or bearish crossover

3. **News & Catalysts**
   - Recent earnings, product launches, regulatory news
   - Market-moving events in last 24h
   - Upcoming catalysts (earnings dates, product events)

4. **Sentiment Analysis**
   - Social media sentiment (bullish/bearish/neutral)
   - Institutional activity (insider buying/selling, analyst upgrades)
   - Options flow (unusual call/put activity)

5. **Investment Thesis**
   - **Bull Case**: What could drive price higher
   - **Bear Case**: Risks and potential downsides
   - **Verdict**: BUY / HOLD / SELL / WAIT with confidence level

## Output Format

Save analysis to: `$HOME/market-analysis/YYYY/MM/DD.md`

Structure the report as follows:

```markdown
# Market Analysis - [Date]

**Generated**: [ISO timestamp]
**Market Status**: [Open/Closed, Pre-market if 6 AM]

---

## 📊 Executive Summary

[2-3 sentence market overview: bullish/bearish/mixed, key drivers today]

**Quick Take:**
- ✅ **Buy Opportunities**: [List 1-3 with brief reason]
- 🔶 **Hold**: [List if applicable]
- ⚠️ **Avoid/Sell**: [List if applicable]

---

## 🏛️ Major Indices

### S&P 500 (SPY)
- **Price**: $XXX.XX (±X.XX%)
- **Trend**: [Uptrend/Downtrend/Consolidation]
- **Analysis**: [2-3 sentences]

[Repeat for NASDAQ, Dow, Russell 2000, VIX]

**Sector Performance**:
- Best: [Sector name] +X.X%
- Worst: [Sector name] -X.X%

---

## 💼 Individual Stocks

### Apple (AAPL)
- **Current**: $XXX.XX (±X.XX%)
- **Technical**: RSI XX | 50MA: $XXX | 200MA: $XXX
- **News**: [Key developments if any]
- **Sentiment**: [Bullish/Bearish/Neutral] - [Why?]
- **Verdict**: **[BUY/HOLD/SELL]** - [One sentence reasoning]

[Repeat for TSLA, NVDA, MSFT, etc.]

---

## ₿ Cryptocurrencies

### Bitcoin (BTC)
- **Price**: $XX,XXX (±X.X%)
- **Market Cap Dominance**: XX.X%
- **Fear & Greed Index**: XX (Extreme Fear/Fear/Neutral/Greed/Extreme Greed)
- **On-Chain**: [Notable metrics: exchange flows, whale activity]
- **Technical**: [Trend, key levels]
- **Verdict**: **[BUY/HOLD/SELL]** - [Reasoning]

### Ethereum (ETH)
[Same structure as Bitcoin]

---

## 📈 Technical Market Overview

- **Market Breadth**: [How many stocks up vs down]
- **Volume**: [Above/below average, what it means]
- **Volatility**: VIX at XX (High/Low/Normal)
- **Put/Call Ratio**: [Bearish/Bullish sentiment]

---

## 📰 Key News & Events

1. **[Headline]**: [Brief summary and impact]
2. **[Headline]**: [Brief summary and impact]
[List top 3-5 market-moving news]

---

## 🔮 Today's Outlook

**Market Direction**: [Expected up/down/sideways]

**Key Levels to Watch**:
- S&P 500: Support at $XXX, Resistance at $XXX
- NASDAQ: [Levels]

**Events Today**:
- [Economic data releases, earnings reports, Fed speakers]

---

## 💡 Investment Recommendations

### 🟢 Top Buy Ideas
1. **[Ticker]**: [Why now is a good entry, catalyst, risk/reward]
2. **[Ticker]**: [Same]
3. **[Ticker]**: [Same]

### 🟡 Watch List (Wait for Better Entry)
- **[Ticker]**: [What needs to happen for it to be a buy]

### 🔴 Avoid / Consider Selling
- **[Ticker]**: [Why it's risky or overvalued]

---

## ⚠️ Risk Factors

- [List 2-3 key risks to watch: Fed policy, geopolitics, earnings season]

---

## 📌 Action Items

- [ ] [Specific actions: "Set price alert for AAPL at $XXX"]
- [ ] [More actions as relevant]

---

**Disclaimer**: This analysis is for informational purposes only and should not be construed as financial advice. Always do your own research and consult with a qualified financial advisor before making investment decisions. Past performance does not guarantee future results.

**Data Sources**: [List sources used]
**Analysis Time**: ~[X] minutes of research
```

## Research Quality Standards

- **Accuracy**: Verify all prices and data from multiple sources
- **Timeliness**: Focus on last 24h developments, don't rehash old news
- **Depth**: Go beyond surface-level - explain WHY moves are happening
- **Actionable**: Provide specific price targets and entry/exit points when possible
- **Balanced**: Present both bull and bear cases fairly

## Special Instructions

1. **Pre-Market Focus**: Since this runs at 6 AM, include pre-market movements if markets are open
2. **Weekend Handling**: On weekends, analyze Friday's close and preview Monday
3. **Crypto 24/7**: Crypto markets never close, always provide latest
4. **Breaking News**: Flag any overnight news that could gap markets at open
5. **Confidence Levels**: Use "High Confidence / Medium / Low" for buy/sell calls
6. **Risk/Reward**: Always mention risk/reward ratio (e.g., "2:1 R/R")

## What NOT to Do

- ❌ Don't just list prices without context
- ❌ Don't make predictions without supporting evidence
- ❌ Don't ignore risk factors
- ❌ Don't recommend penny stocks or meme stocks without huge disclaimers
- ❌ Don't be overly bullish or bearish - stay objective

## Advanced Analysis (When Relevant)

Include when applicable:
- **Correlation Analysis**: How assets move together (SPY vs BTC, etc.)
- **Seasonality**: "Historically, [asset] tends to [trend] in [month]"
- **Institutional Flows**: Notable ETF inflows/outflows, 13F filings
- **Global Context**: How Asian and European markets performed
- **Futures**: How S&P, Dow, NASDAQ futures are trading pre-market

## Error Handling

If unable to fetch data for specific assets:
- Note the limitation in the report
- Use last available data with timestamp
- Adjust confidence level accordingly

---

**Goal**: Provide a comprehensive, actionable market analysis that empowers informed investment decisions while maintaining objectivity and acknowledging risks.

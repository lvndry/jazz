---
name: investment-analysis
description: In-depth analysis of investment assets (gold, silver, bitcoin, equities, etc.) to support investment decisions. Use when the user wants to understand an asset's current state, market analysis, patterns, forecasts, or whether it fits their situation. Triggers on "investment analysis", "analyze gold/bitcoin/silver", "should I invest in X", "current state of X", "market analysis", "is X a good investment".
---

# Investment Analysis

Investment decisions affect real wealth and real lives. This skill provides in-depth analysis—grounded in investor frameworks (value, macro, growth, risk)—to support your decisions. When the analysis supports a view, give a **clear, sourced, nuanced conclusion** tailored to the user's profile. Avoid vague hedging; substance and conviction (when justified) build trust.

For mindset and frameworks, see [references/investment-mindset.md](references/investment-mindset.md).

## When to Use

- User wants to analyze an asset (gold, silver, bitcoin, a stock, ETF, or commodity)
- User asks "should I invest in X?" or "is X a good investment?"
- User wants current market state, patterns, or forecasts for an asset
- User wants to know if an asset fits their goals, risk, or time horizon
- User asks for "investment analysis", "market analysis", or "pattern recognition" for an asset

## Disclaimer & Scope

**This is not licensed investment, tax, or legal advice.** No guarantee of returns. For major decisions (large sums, complex situations, tax/estate), recommend consulting a qualified professional.

**Do give actionable conclusions** when analysis supports them: sourced, justified, tied to the user's goals, risk, and horizon. The user deserves a clear view, not a hand-off. State confidence level and caveats.

## Workflow

1. **Clarify asset and user situation**: Which asset? User's goals (growth, income, hedge), risk tolerance, time horizon, and (if shared) existing exposure.
2. **Gather current state**: Price, volume, recent trend, key levels. Use recent data; cite source and date.
3. **Apply investment mindset**: Use frameworks from [references/investment-mindset.md](references/investment-mindset.md)—Buffett/Munger (value, margin of safety), Dalio (macro), Lynch (story), Marks (risk/cycles), Graham (intrinsic value)—to deepen analysis. Avoid shallow takes.
4. **Analyze patterns and context**: Technical patterns, sentiment, on-chain (for crypto), macro context (rates, inflation, geopolitics) where relevant.
5. **Consider forecasts and previsions**: What analysts or models say (bull/bear cases). Label as outlook, not fact.
6. **Assess fit for situation**: Does the asset align with the user's goals, risk, and horizon? Pros and cons in that context.
7. **Present analysis**: Structured report with current state, patterns, outlook, fit, risks, and caveats. When analysis supports a view, state it clearly—e.g. "For your profile, a small allocation (X–Y%) could fit because [sourced reasons]" or "Given your horizon and risk tolerance, this asset is likely misaligned—[reasons]."

## What to Analyze

### Current State

- **Price**: Current level, recent range (e.g. 30/90 days), key support/resistance if useful
- **Volume / liquidity**: Where relevant (e.g. crypto, equities)
- **Trend**: Short- and medium-term direction; cite time frame
- **Context**: Rates, inflation, dollar, geopolitics—only what’s relevant to the asset

Cite source and date for every number (e.g. "BTC price as of [date] per [source]").

### Pattern Recognition

- **Technical**: Trends, ranges, common patterns (e.g. breakout, consolidation). Describe, don’t guarantee.
- **Sentiment**: Fear/greed, positioning, flows—when data is available and relevant
- **On-chain (crypto)**: Active addresses, supply in profit/loss, exchange flows—when available
- **Seasonal / cyclical**: Historical patterns (e.g. gold in certain periods); state that past ≠ future

Label clearly: "pattern observed" vs "forecast or interpretation."

### Forecasts and Previsions

- **Analyst views**: Summarize bull/bear cases; name source and date
- **Model-based**: E.g. valuation bands, trend extrapolation—state assumptions
- **Scenarios**: Best / base / worst case with clear "if X then Y" and caveats

No single "this will happen" claim; present range of views and uncertainty.

### Fit for User Situation

- **Goals**: Growth vs income vs hedge vs diversification
- **Risk tolerance**: Volatility, drawdowns, loss capacity
- **Time horizon**: Short vs long term; liquidity needs
- **Existing exposure**: Already heavy in the asset? Diversification benefit?

Output: A clear conclusion with reasoning. E.g. "Given [situation], I'd lean [for/against/neutral] because [sourced reasons]. Consider [suggested allocation or action] if [conditions]." Tie every view to sources and profile.

## Output Format

```markdown
# Investment Analysis: [Asset] — [Date]

## Summary
[2–4 sentences: current state, main pattern/outlook, and fit with user situation. Include a clear conclusion when analysis supports it—e.g. "For a long-term, risk-tolerant profile, a small allocation could fit; for short horizons, likely misaligned."]

## Your Situation (as shared)
- Goals: [e.g. long-term growth, hedge inflation]
- Risk: [e.g. moderate, can tolerate 20% drawdown]
- Horizon: [e.g. 5+ years]
- [Optional] Current exposure: [e.g. none, 5% in gold]

## Current Market State
- **Price / level**: [value] as of [date] ([source])
- **Recent trend**: [e.g. up/down/sideways over 30/90 days]
- **Context**: [rates, inflation, or other relevant factor in 1–2 lines]

## Patterns & Indicators
- [Pattern 1]: [What you see and time frame]
- [Pattern 2]: [What you see and time frame]
- [Sentiment / on-chain if relevant]: [1–2 lines]

## Outlook & Previsions
- **Bull case**: [Short summary + source/date if applicable]
- **Bear case**: [Short summary]
- **Base case / range**: [If useful, with assumptions stated]

## Fit for Your Situation
- **Pros**: [How it could align with goals/risk/horizon]
- **Cons**: [Risks or misalignment with situation]
- **Conclusion**: [Clear view with reasoning. E.g. "For your profile (long-term, moderate risk), a 2–5% allocation could fit as a diversification/hedge—because [sourced reasons]. I'd avoid or minimize if [conditions]." Or "Given your short horizon, I'd lean against—[reasons]." State confidence and caveats.]

## Risks & Caveats
- [Risk 1]
- [Risk 2]
- Past performance does not guarantee future results. For large or complex decisions, consult a qualified professional.
```

## Asset Coverage

- **Precious metals**: Gold, silver—price, trend, macro context (real rates, dollar, geopolitics), common use as hedge.
- **Crypto**: Bitcoin (and optionally major altcoins)—price, volume, on-chain metrics, sentiment, regulatory/macro tailwinds/risks.
- **Equities / ETFs**: Single names or broad indices—valuation, trend, sector context; same "current state + patterns + outlook + fit" structure.

For asset-specific metrics and data sources, see [references/assets.md](references/assets.md).

## Time Awareness

- **User specifies a period** (e.g. "last 6 months", "2024") → Use that period for trends and data.
- **No period given** → Use **most recent** data (e.g. current price, last 30/90 days for trend).
- Always state the date and source for prices and metrics (e.g. "as of [date] per [source]").

## Sources

- **Prices / market data**: Exchange or index provider, reputable aggregator (e.g. CoinGecko for crypto). Cite URL or name and date.
- **On-chain (crypto)**: Public dashboards (e.g. Glassnode, CryptoQuant). Cite name and date.
- **Macro**: Central banks, statistical offices, widely cited data. Cite source and date.
- **Analyst views**: Named source and date; treat as opinion, not fact.

Prefer primary or well-known sources. Never invent data.

## Anti-Patterns

- ❌ Giving conclusions without sources, reasoning, or profile fit (vague advice erodes trust)
- ❌ Over-hedging when analysis supports a view—the user deserves a clear take
- ❌ Guaranteeing returns or price levels
- ❌ Using data without source and date
- ❌ Presenting one view as certainty; show range and uncertainty
- ❌ Ignoring user situation; always tie fit to goals, risk, and horizon
- ❌ Skipping risks and caveats

# Assets & What to Analyze

Reference for asset types and relevant metrics/sources. Use when building an investment analysis.

## Precious Metals (Gold, Silver)

### What to Look At

| Aspect                      | What to analyze                                                | Notes                                              |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| **Price**                   | Spot price (e.g. USD/oz), 30/90-day range                      | Cite exchange or index (e.g. LBMA, COMEX)          |
| **Trend**                   | Short- and medium-term direction                               | Real rates and dollar often drive gold             |
| **Macro context**           | Real yields (TIPS), dollar index (DXY), inflation expectations | Gold often inverse to real rates and strong dollar |
| **Sentiment / positioning** | COT (Commitment of Traders), ETF flows                         | Optional; cite source                              |
| **Use case**                | Hedge (inflation, volatility), diversification                 | State how it fits user goals                       |

### Typical Data Sources

- **Price**: LBMA, COMEX, major indices (e.g. XAU, XAG)
- **Macro**: Fed, Treasury (TIPS), BLS (inflation)
- **Flows**: ETF provider (e.g. SPDR Gold), COT reports

---

## Bitcoin & Crypto

### What to Look At

| Aspect        | What to analyze                                                                | Notes                                                  |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **Price**     | Spot, 30/90-day range, ATH distance                                            | Cite exchange or index (e.g. CoinGecko, CoinMarketCap) |
| **Volume**    | Spot and derivatives volume                                                    | Liquidity and interest                                 |
| **On-chain**  | Active addresses, supply in profit/loss, exchange inflows/outflows, HODL waves | Optional; cite dashboard                               |
| **Sentiment** | Fear & Greed, funding rates, open interest                                     | Label as sentiment, not forecast                       |
| **Context**   | Rates, regulation, adoption, halving cycle                                     | Tailwinds and risks                                    |
| **Use case**  | Growth, hedge (narrative), diversification                                     | State how it fits user goals and risk                  |

### Typical Data Sources

- **Price / volume**: CoinGecko, CoinMarketCap, exchange (e.g. Binance, Coinbase)
- **On-chain**: Glassnode, CryptoQuant, blockchain explorers
- **Sentiment**: Fear & Greed Index, funding rates on major exchanges

---

## Equities & ETFs

### What to Look At

| Aspect        | What to analyze                                         | Notes                         |
| ------------- | ------------------------------------------------------- | ----------------------------- |
| **Price**     | Current price, 30/90-day range, 52-week high/low        | Cite exchange or provider     |
| **Valuation** | P/E, P/S, or ETF metrics (e.g. expense ratio, holdings) | Context: sector, history      |
| **Trend**     | Short- and medium-term direction                        | Support/resistance if useful  |
| **Context**   | Sector, rates, earnings (if single name)                | What’s driving or could drive |
| **Use case**  | Growth, income, diversification                         | Fit with goals and horizon    |

### Typical Data Sources

- **Price / fundamentals**: Exchange, Yahoo Finance, company IR, ETF provider
- **Macro**: Fed, Treasury, earnings calendars

---

## General Rules

1. **Always cite source and date** for price and any metric.
2. **State time frame** for trends (e.g. "last 30 days", "since 2024").
3. **Label opinions and forecasts**; don’t present as fact.
4. **Tie analysis to user situation** (goals, risk, horizon) in the main skill output.

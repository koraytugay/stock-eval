# StockEval

An automated, serverless equity valuation and look-through ETF engine powered by **GitHub Actions** and hosted on **GitHub Pages**.

## Overview
* **Universe:** S&P 500, Invesco QQQ (Nasdaq 100), TSE:XIC (S&P/TSX Composite), and user-defined custom ETFs.
* **Valuation Models:** 
  * Multi-Stage Free Cash Flow to Firm (FCFF) Discounted Cash Flow (DCF).
  * Reverse DCF (solving for market-implied growth rate).
  * Look-through constituent weighted valuations for custom ETFs.
* **Storage:** Clean, flat historical JSON snapshots (`data/snapshots/YYYY-MM-DD.json`). No external databases or servers needed.
* **Frontend:** Static HTML/JS/CSS hosted on GitHub Pages with historical backtesting and ETF breakdown.

## Custom ETF Configuration
You can define any ETF (such as `TSE:CADE`, `TSE:CAUS`, or custom baskets) in [`config/custom_etfs.json`](file:///Users/kt/github/koraytugay/stock-eval/config/custom_etfs.json):

```json
{
  "etfs": {
    "TSE:CAUS": {
      "name": "CI U.S. Equity Index ETF",
      "currency": "CAD",
      "holdings": [
        { "ticker": "MSFT", "weight": 0.25 },
        { "ticker": "AAPL", "weight": 0.25 },
        { "ticker": "GOOGL", "weight": 0.25 },
        { "ticker": "AMZN", "weight": 0.25 }
      ]
    }
  }
}
```

## Running Locally

1. **Update Universe:**
   ```bash
   python3 scripts/update_universe.py
   ```

2. **Run Daily Valuation Snapshot:**
   ```bash
   python3 scripts/fetch_and_evaluate.py
   ```

3. **Preview Webpage:**
   ```bash
   python3 -m http.server 8000
   # Open http://localhost:8000/docs/
   ```

## Automated GitHub Workflow
* Scheduled via [`.github/workflows/daily_eval.yml`](file:///Users/kt/github/koraytugay/stock-eval/.github/workflows/daily_eval.yml) to execute daily at 12:00 PM EST (16:00 UTC).
* Collects raw point-in-time fundamentals and market prices, commits new snapshot JSONs, and updates the GitHub Pages site.

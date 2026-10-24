# StockEval

An automated, serverless equity valuation and look-through ETF engine powered by **GitHub Actions** and hosted on **GitHub Pages**.

## Overview
* **Universe:** S&P 500, Invesco QQQ (Nasdaq 100), a large-cap proxy list for TSE:XIC (S&P/TSX Composite), and user-defined custom ETFs.
* **Data sources:**
  * Prices and FX rates: Yahoo Finance chart endpoint.
  * Fundamentals: SEC EDGAR XBRL `companyfacts` (trailing-twelve-month FCF from 10-K + 10-Q where available); Yahoo Finance fundamentals for non-SEC listings such as `.TO` tickers.
* **Valuation Models:**
  * Multi-Stage Free Cash Flow to Firm (FCFF) Discounted Cash Flow (DCF), with sector WACC and growth estimated from historical FCF CAGR (clamped).
  * Reverse DCF (solving for the market-implied growth rate).
  * Look-through valuation for custom ETFs (intrinsic value per $1 invested).
* **Storage:** Flat historical JSON snapshots (`data/snapshots/YYYY-MM-DD.json`). No external databases or servers needed.
* **Frontend:** Static HTML/JS/CSS hosted on GitHub Pages with historical backtesting and ETF breakdown.

Stocks that cannot be valued (negative FCF, missing share count, no fundamentals) are shown with a reason instead of a number. An FCFF DCF is not meaningful for banks and insurers, so the Financials sector is excluded by default (`excluded_sectors`).

## Configuration

### Model assumptions — [`config/model_params.json`](config/model_params.json)
* `default_wacc` and `sector_wacc` (keyed by GICS sector)
* `excluded_sectors`: sectors that are not valued (default: Financials)
* `terminal_growth`, `forecast_years`
* `growth`: `default` (used when history is too short or not positive), `floor`, `cap`, `min_history_years`
* `fundamentals_cache`: entries older than `stale_after_days` are refetched, at most `max_refresh_per_run` per run
* `min_priced_fraction`: the run fails without writing a snapshot if fewer than this share of tickers get a price

### Custom ETFs — [`config/custom_etfs.json`](config/custom_etfs.json)

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

### SEC User-Agent
The SEC asks automated clients to identify themselves. Set the `SEC_USER_AGENT` environment variable (locally) or a repository **variable** of the same name (in GitHub Actions) to something like `Your Name you@example.com`.

## Running Locally

1. **Run tests:**
   ```bash
   python3 -m unittest discover -s tests
   ```

2. **Update Universe:**
   ```bash
   python3 scripts/update_universe.py
   ```

3. **Run Daily Valuation Snapshot:**
   ```bash
   python3 scripts/fetch_and_evaluate.py
   ```

4. **Preview Webpage:**
   ```bash
   python3 -m http.server 8000
   # Open http://localhost:8000/docs/
   ```

## Automated GitHub Workflow
* Scheduled via [`.github/workflows/daily_eval.yml`](.github/workflows/daily_eval.yml) to run daily at 16:00 UTC (12:00 PM EDT / 11:00 AM EST).
* Runs the unit tests, refreshes the universe, collects prices and fundamentals, and commits new snapshot JSONs to `main`.
* GitHub Pages serves the `main` branch root; `index.html` redirects to the dashboard in `docs/`, which reads `data/` directly.

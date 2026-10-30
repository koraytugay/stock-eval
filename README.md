# StockEval

An automated, serverless equity valuation and look-through ETF engine powered by **GitHub Actions** and hosted on **GitHub Pages**.

## Overview
* **Universe:** S&P 500, Invesco QQQ (Nasdaq 100), a large-cap proxy list for TSE:XIC (S&P/TSX Composite), and the top holdings of the configured ETFs (including international stocks).
* **Data sources:**
  * Prices and FX rates: Yahoo Finance chart endpoint.
  * Fundamentals: SEC EDGAR XBRL `companyfacts` (trailing-twelve-month FCF from 10-K + 10-Q where available); Yahoo Finance fundamentals for non-SEC listings such as `.TO` tickers.
* **Valuation Models:**
  * Multi-Stage Free Cash Flow to Firm (FCFF) Discounted Cash Flow (DCF), with sector WACC, normalized (multi-year average) FCF, and growth from a robust (Theil-Sen) fit of historical FCF (clamped).
  * Reverse DCF (solving for the market-implied growth rate).
  * Look-through valuation for custom ETFs (intrinsic value per $1 invested).
* **Storage:** Flat historical JSON snapshots (`data/snapshots/YYYY-MM-DD.json`). No external databases or servers needed.
* **Frontend:** Static HTML/JS/CSS hosted on GitHub Pages: filterable equity table (click a row to see every input behind its valuation), ETF breakdown, and a backtest comparing the cheapest and most expensive stocks against the equal-weight average.

Stocks that cannot be valued (negative FCF, missing share count, no fundamentals) are shown with a reason instead of a number. When debt exceeds the modelled enterprise value, the equity value is floored at zero. An FCFF DCF is not meaningful for banks and insurers, so the Financials sector is excluded by default (`excluded_sectors`).

## Configuration

### Model assumptions — [`config/model_params.json`](config/model_params.json)
* `default_wacc` and `sector_wacc` (keyed by GICS sector)
* `excluded_sectors`: sectors that are not valued (default: Financials)
* `fcf_normalization_years`: the DCF uses the average of the latest FCF and the preceding fiscal years (1 = latest only)
* `terminal_growth`, `forecast_years`
* `growth`: `default` (used when history is too short or not positive), `floor`, `cap`, `min_history_years`
* `fundamentals_cache`: entries older than `stale_after_days` (staggered per ticker) are refetched, at most `max_refresh_per_run` per run. `filing_window` makes refreshes follow the reporting calendar: from `lag_days` after the cached period end (a new 10-Q is due) and for `window_days`, an entry is rechecked every `recheck_days` until the new period appears
* `min_priced_fraction`: the run fails without writing a snapshot if fewer than this share of tickers get a price

### ETFs — [`config/custom_etfs.json`](config/custom_etfs.json)
Each ETF is valued by look-through. With `holdings_page` (a stockanalysis.com path) the published top holdings are fetched on every run, and funds of funds are expanded into the holdings of their underlying ETFs (`fund_aliases` maps an underlying fund without its own page to an equivalent one). Holdings can also be listed by hand:

```json
{
  "etfs": {
    "TSE:XEQT": { "name": "iShares Core Equity ETF Portfolio", "currency": "CAD", "holdings_page": "quote/tsx/XEQT" },
    "MY:BASKET": { "name": "Hand-picked basket", "currency": "CAD",
                   "holdings": [{ "ticker": "MSFT", "weight": 0.5 }, { "ticker": "RY.TO", "weight": 0.5 }] }
  }
}
```

Free holdings pages only list the top 10–25 positions, so each ETF card reports how much of the fund the published holdings cover and how much of it is actually valued. International holdings are priced and valued through Yahoo Finance (London prices are converted from pence; ADR share ratios are inferred from market cap).

### Valuation history
`data/etf_history.json` holds one row per ETF per trading day (intrinsic value per $1, premium vs DCF, valued weight). The daily run appends the day's values; the ETF tab charts the past year and labels each ETF *cheaper than usual*, *typical* or *pricier than usual* from the percentile of today's premium within that history (bottom/top 20%).

The first year was reconstructed with `python3 scripts/backfill_etf_history.py`, which replays historical prices and point-in-time fundamentals (SEC facts filed by each month start; Yahoo periods ending 60+ days earlier) against **today's** holdings. That part of the chart is shaded and marked as reconstructed. Re-run it after adding an ETF to give the new one a history.

### SEC User-Agent
The SEC asks automated clients to identify themselves. Set the `SEC_USER_AGENT` environment variable (locally) or a repository **variable** of the same name (in GitHub Actions) to something like `Your Name you@example.com`.

## Running Locally

1. **Run tests:**
   ```bash
   python3 -m unittest discover -s tests
   node --test tests/decision.test.js   # dashboard stance logic
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
* Scheduled via [`.github/workflows/daily_eval.yml`](.github/workflows/daily_eval.yml) to run on weekdays at 21:30 UTC (5:30 PM EDT / 4:30 PM EST, after the NYSE and TSX close).
* Runs the unit tests, refreshes the universe, collects prices and fundamentals, and commits new snapshot JSONs to `main`.
* GitHub Pages serves the `main` branch root; `index.html` redirects to the dashboard in `docs/`, which reads `data/` directly.

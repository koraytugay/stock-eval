"""
Core Data Extraction and Valuation Pipeline:
1. Loads universe (SP500, QQQ, XIC, Custom ETFs) and model assumptions (config/model_params.json).
2. Retrieves market prices and fundamentals (SEC EDGAR, Yahoo fallback), refreshing stale cache entries.
3. Computes Forward DCF and Reverse DCF (implied growth rate), converting currencies where needed.
4. Aggregates look-through valuation for custom ETFs.
5. Saves daily raw snapshot to data/snapshots/YYYY-MM-DD.json and data/latest.json.

Exits non-zero without writing a snapshot if too few prices could be fetched.
"""

import sys
import json
import datetime
from pathlib import Path

from data_sources import SCHEMA_VERSION, fetch_market_price, fetch_fx_rate, fetch_fundamentals
from valuation_models import compute_dcf, compute_reverse_dcf, estimate_growth, etf_look_through

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
UNIVERSE_FILE = DATA_DIR / "universe" / "universe.json"
CACHE_FILE = DATA_DIR / "fundamentals_cache.json"
PARAMS_FILE = BASE_DIR / "config" / "model_params.json"


def load_json(path, default):
    if path.exists():
        with open(path, "r") as f:
            return json.load(f)
    return default


def save_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)


def is_stale(entry, today, stale_after_days):
    if not entry or entry.get("schema") != SCHEMA_VERSION or not entry.get("fetched_at"):
        return True
    age = (today - datetime.date.fromisoformat(entry["fetched_at"])).days
    return age >= stale_after_days


def refresh_fundamentals(tickers, cache, today, params):
    """Refetches missing/stale cache entries, oldest first, up to the per-run budget."""
    cache_cfg = params["fundamentals_cache"]
    stale = [t for t in tickers if is_stale(cache.get(t), today, cache_cfg["stale_after_days"])]
    stale.sort(key=lambda t: (cache.get(t) or {}).get("fetched_at") or "")
    budget = stale[:cache_cfg["max_refresh_per_run"]]
    print(f"Fundamentals: {len(stale)} stale/missing, refreshing {len(budget)}")

    for idx, ticker in enumerate(budget, 1):
        record = fetch_fundamentals(ticker, today.isoformat())
        # Negative-cache tickers with no data so they are retried only once they go stale
        cache[ticker] = record or {"schema": SCHEMA_VERSION, "fetched_at": today.isoformat(), "source": None}
        if idx % 50 == 0:
            print(f"  ...{idx}/{len(budget)}")


def value_stock(price, price_ccy, fund, sector, params):
    """Returns (valuation dict or None, status string)."""
    if sector in params.get("excluded_sectors", []):
        return None, "sector_excluded"
    if not fund or not fund.get("source"):
        return None, "no_fundamentals"
    if not fund.get("shares_outstanding"):
        return None, "no_shares"
    fcf = fund.get("free_cash_flow")
    if fcf is None or fcf <= 0:
        return None, "negative_fcf"

    fx = fetch_fx_rate(fund.get("currency", "USD"), price_ccy)
    if fx is None:
        return None, "no_fx_rate"

    wacc = params["sector_wacc"].get(sector, params["default_wacc"])
    g_cfg = params["growth"]
    growth, growth_source = estimate_growth(fund.get("fcf_history"), g_cfg["default"], g_cfg["floor"],
                                            g_cfg["cap"], g_cfg["min_history_years"])
    shares, net_debt = fund["shares_outstanding"], fund.get("net_debt", 0.0)

    dcf = compute_dcf(fcf=fcf, growth_rate=growth, terminal_growth=params["terminal_growth"], wacc=wacc,
                      net_debt=net_debt, shares=shares, forecast_years=params["forecast_years"])
    if not dcf:
        return None, "model_not_applicable"

    # Fundamentals may be reported in a different currency than the listing (e.g. USD reporters on the TSX)
    intrinsic = round(dcf["intrinsic_value"] * fx, 2)
    reverse = compute_reverse_dcf(market_price=price / fx, fcf=fcf, shares=shares, net_debt=net_debt, wacc=wacc,
                                  terminal_growth=params["terminal_growth"], forecast_years=params["forecast_years"])

    return {
        "intrinsic_dcf": intrinsic,
        "market_premium_pct": round((price - intrinsic) / intrinsic * 100.0, 2) if intrinsic > 0 else None,
        "implied_growth_reverse_dcf": reverse["growth"] if reverse else None,
        "implied_growth_status": reverse["status"] if reverse else None,
        "wacc": wacc,
        "growth_rate_assumed": growth,
        "growth_source": growth_source,
        "fx_rate": fx
    }, "ok"


def run_daily_evaluation():
    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date()
    today_str = today.isoformat()
    print(f"[{now.isoformat()}] Starting daily evaluation...")

    params = load_json(PARAMS_FILE, None)
    if params is None:
        sys.exit(f"Missing {PARAMS_FILE}")

    if not UNIVERSE_FILE.exists():
        import update_universe
        update_universe.update_all_universes()
    universe_data = load_json(UNIVERSE_FILE, {})

    index_members = {name: set(universe_data.get(name, {}).get("tickers", [])) for name in ("SP500", "QQQ", "XIC")}
    sectors = universe_data.get("SECTORS", {})
    custom_etfs = universe_data.get("CUSTOM", {})

    all_tickers = set().union(*index_members.values())
    for etf_obj in custom_etfs.values():
        all_tickers.update(h["ticker"] for h in etf_obj.get("holdings", []) if h.get("ticker"))
    all_tickers = sorted(all_tickers)
    print(f"Total unique constituents in universe: {len(all_tickers)}")

    # Prices first, so fundamentals are only fetched for tradable tickers
    prices = {}
    for ticker in all_tickers:
        price, currency = fetch_market_price(ticker)
        if price is not None:
            prices[ticker] = (price, currency or "USD")

    min_priced = int(len(all_tickers) * params["min_priced_fraction"])
    if len(prices) < min_priced:
        sys.exit(f"ERROR: only {len(prices)}/{len(all_tickers)} prices fetched (need {min_priced}). "
                 "Not writing a snapshot.")

    cache = load_json(CACHE_FILE, {})
    try:
        refresh_fundamentals(sorted(prices), cache, today, params)
    except Exception as e:
        save_json(CACHE_FILE, cache)
        sys.exit(f"ERROR: fundamentals refresh failed ({e}). Is SEC_USER_AGENT set to 'Name email'? "
                 "Not writing a snapshot.")
    save_json(CACHE_FILE, cache)

    today_snapshot = {
        "date": today_str,
        "timestamp": now.isoformat(),
        "model": {k: params[k] for k in ("forecast_years", "terminal_growth", "default_wacc", "growth")},
        "stocks": {},
        "etfs": {}
    }

    status_counts = {}
    for ticker, (price, currency) in prices.items():
        fund = cache.get(ticker) or {}
        has_data = bool(fund.get("source"))
        valuation, status = value_stock(price, currency, fund, sectors.get(ticker), params)
        status_counts[status] = status_counts.get(status, 0) + 1

        entry = {
            "ticker": ticker,
            "currency": currency,
            "market_price": price,
            "sector": sectors.get(ticker),
            "indices": [name for name, members in index_members.items() if ticker in members],
            "valuation_status": status,
            "raw": {k: v for k, v in fund.items() if k not in ("schema", "fcf_history")} if has_data else {}
        }
        if valuation:
            entry["valuation"] = valuation
        today_snapshot["stocks"][ticker] = entry

    print(f"Valuation status: {status_counts}")

    for etf_id, etf_obj in custom_etfs.items():
        holdings = etf_obj.get("holdings", [])
        today_snapshot["etfs"][etf_id] = {
            "name": etf_obj.get("name", etf_id),
            "currency": etf_obj.get("currency", "CAD"),
            **etf_look_through(holdings, today_snapshot["stocks"]),
            "holdings": holdings
        }

    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_path = SNAPSHOTS_DIR / f"{today_str}.json"
    save_json(snapshot_path, today_snapshot)
    save_json(DATA_DIR / "latest.json", today_snapshot)

    index_path = DATA_DIR / "history_index.json"
    history = load_json(index_path, [])
    if today_str not in history:
        history.append(today_str)
        history.sort()
    save_json(index_path, history)

    print(f"Evaluation complete! Saved {len(today_snapshot['stocks'])} stocks and "
          f"{len(today_snapshot['etfs'])} ETFs to {snapshot_path}")


if __name__ == "__main__":
    run_daily_evaluation()

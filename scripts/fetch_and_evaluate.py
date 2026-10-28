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
from concurrent.futures import ThreadPoolExecutor

from data_sources import SCHEMA_VERSION, fetch_market_price, fetch_fx_rate, fetch_fundamentals
from valuation_models import (compute_dcf, compute_reverse_dcf, estimate_growth, normalized_fcf, etf_look_through,
                              infer_adr_ratio)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
UNIVERSE_FILE = DATA_DIR / "universe" / "universe.json"
CACHE_FILE = DATA_DIR / "fundamentals_cache.json"
ETF_HISTORY_FILE = DATA_DIR / "etf_history.json"
PARAMS_FILE = BASE_DIR / "config" / "model_params.json"

# Dated snapshots accumulate in git, so they keep only the raw fields the table and backtest use
SNAPSHOT_RAW_FIELDS = ("source", "currency", "filed", "fetched_at", "fcf_basis", "free_cash_flow", "net_debt")


def load_json(path, default):
    if path.exists():
        with open(path, "r") as f:
            return json.load(f)
    return default


def save_json(path, obj, compact=False):
    # Snapshots are written daily and kept in git, so they are stored without whitespace
    with open(path, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=2)


def etf_history_row(date, etf):
    """Compact daily history row: [date, intrinsic per $1, premium %, valued weight %, market_price]."""
    return [date, etf.get("intrinsic_per_dollar"), etf.get("market_premium_pct"), etf.get("covered_weight_pct"), etf.get("market_price")]


def update_etf_history(date, etfs, history=None):
    """Upserts one day's ETF valuations into the history (rows sorted by date)."""
    history = history if history is not None else load_json(ETF_HISTORY_FILE, {"backfilled_until": None, "etfs": {}})
    for etf_id, etf in etfs.items():
        rows = [r for r in history["etfs"].get(etf_id, []) if r[0] != date]
        rows.append(etf_history_row(date, etf))
        history["etfs"][etf_id] = sorted(rows, key=lambda r: r[0])
    return history


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


def model_inputs(fund, sector, params):
    """DCF inputs for a stock in its reporting currency. Returns (inputs dict or None, status string)."""
    if sector in params.get("excluded_sectors", []):
        return None, "sector_excluded"
    if not fund or not fund.get("source"):
        return None, "no_fundamentals"
    if not fund.get("shares_outstanding"):
        return None, "no_shares"
    fcf = normalized_fcf(fund.get("free_cash_flow"), fund.get("fcf_history"), fund.get("fcf_basis", "FY"),
                         params.get("fcf_normalization_years", 1))
    if fcf is None or fcf <= 0:
        return None, "negative_fcf"

    g_cfg = params["growth"]
    growth, growth_source = estimate_growth(fund.get("fcf_history"), g_cfg["default"], g_cfg["floor"],
                                            g_cfg["cap"], g_cfg["min_history_years"])
    return {
        "fcf": fcf,
        "wacc": params["sector_wacc"].get(sector, params["default_wacc"]),
        "growth": growth,
        "growth_source": growth_source,
        "shares": fund["shares_outstanding"],
        "net_debt": fund.get("net_debt", 0.0),
    }, "ok"


def value_stock(ticker, price, price_ccy, fund, sector, params):
    """Returns (valuation dict or None, status string)."""
    inputs, status = model_inputs(fund, sector, params)
    if not inputs:
        return None, status

    fx = fetch_fx_rate(fund.get("currency", "USD"), price_ccy)
    if fx is None:
        return None, "no_fx_rate"

    fcf, wacc, growth, growth_source = inputs["fcf"], inputs["wacc"], inputs["growth"], inputs["growth_source"]
    shares, net_debt = inputs["shares"], inputs["net_debt"]

    # A US-listed foreign company (ADR) trades in receipts that can each represent several ordinary shares;
    # express the share count in receipts so the per-share value matches the quoted price
    adr_ratio = None
    if fund.get("source") == "Yahoo Finance" and "." not in ticker and fund.get("market_cap"):
        mcap_fx = fetch_fx_rate(price_ccy, fund.get("market_cap_currency") or price_ccy)
        if mcap_fx:
            adr_ratio = infer_adr_ratio(price * mcap_fx, fund["market_cap"], shares)
            if adr_ratio:
                shares = shares / adr_ratio

    dcf = compute_dcf(fcf=fcf, growth_rate=growth, terminal_growth=params["terminal_growth"], wacc=wacc,
                      net_debt=net_debt, shares=shares, forecast_years=params["forecast_years"])
    if not dcf:
        return None, "model_not_applicable"

    # Fundamentals may be reported in a different currency than the listing (e.g. USD reporters on the TSX)
    intrinsic = round(dcf["intrinsic_value"] * fx, 2)
    reverse = compute_reverse_dcf(market_price=price / fx, fcf=fcf, shares=shares, net_debt=net_debt, wacc=wacc,
                                  terminal_growth=params["terminal_growth"], forecast_years=params["forecast_years"])

    # Debt exceeding enterprise value leaves nothing for shareholders; equity cannot be worth less than zero
    status = "ok" if intrinsic > 0 else "debt_exceeds_value"
    return {
        "intrinsic_dcf": max(intrinsic, 0.0),
        "market_premium_pct": round((price - intrinsic) / intrinsic * 100.0, 2) if intrinsic > 0 else None,
        "fcf_used": fcf,
        "enterprise_value": round(dcf["enterprise_value"], 3),
        "implied_growth_reverse_dcf": reverse["growth"] if reverse else None,
        "implied_growth_status": reverse["status"] if reverse else None,
        "wacc": wacc,
        "growth_rate_assumed": growth,
        "growth_source": growth_source,
        "fx_rate": fx,
        "adr_ratio": adr_ratio if adr_ratio not in (None, 1) else None
    }, status


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
    etf_yahoo_tickers = {
        etf_id: etf_id.replace("TSE:", "") + (".TO" if etf_id.startswith("TSE:") else "")
        for etf_id in custom_etfs.keys()
    }
    for etf_obj in custom_etfs.values():
        all_tickers.update(h["ticker"] for h in etf_obj.get("holdings", []) if h.get("ticker"))
    all_tickers.update(etf_yahoo_tickers.values())
    all_tickers = sorted(all_tickers)
    print(f"Total unique constituents in universe: {len(all_tickers)}")

    # Prices first, so fundamentals are only fetched for tradable tickers
    with ThreadPoolExecutor(max_workers=8) as pool:
        quotes = dict(zip(all_tickers, pool.map(fetch_market_price, all_tickers)))
    prices = {t: (p, c or "USD") for t, (p, c) in quotes.items() if p is not None}

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
        "model": {k: params.get(k) for k in ("forecast_years", "terminal_growth", "default_wacc", "growth",
                                             "fcf_normalization_years", "excluded_sectors")},
        "stocks": {},
        "etfs": {}
    }

    status_counts = {}
    for ticker, (price, currency) in prices.items():
        fund = cache.get(ticker) or {}
        has_data = bool(fund.get("source"))
        valuation, status = value_stock(ticker, price, currency, fund, sectors.get(ticker), params)
        status_counts[status] = status_counts.get(status, 0) + 1

        entry = {
            "ticker": ticker,
            "currency": currency,
            "market_price": price,
            "sector": sectors.get(ticker),
            "indices": [name for name, members in index_members.items() if ticker in members],
            "valuation_status": status,
            "raw": {**{k: v for k, v in fund.items() if k != "schema"},
                    "fcf_history": fund.get("fcf_history", [])[-6:]} if has_data else {}
        }
        if valuation:
            entry["valuation"] = valuation
        today_snapshot["stocks"][ticker] = entry

    print(f"Valuation status: {status_counts}")

    for etf_id, etf_obj in custom_etfs.items():
        holdings = etf_obj.get("holdings", [])
        yt = etf_yahoo_tickers.get(etf_id)
        p, c = prices.get(yt, (None, None))
        today_snapshot["etfs"][etf_id] = {
            "name": etf_obj.get("name", etf_id),
            "currency": c or etf_obj.get("currency", "CAD"),
            "market_price": p,
            **etf_look_through(holdings, today_snapshot["stocks"]),
            "holdings": holdings
        }

    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_path = SNAPSHOTS_DIR / f"{today_str}.json"
    slim = {**today_snapshot, "stocks": {
        t: {**e, "raw": {k: e["raw"][k] for k in SNAPSHOT_RAW_FIELDS if k in e["raw"]}}
        for t, e in today_snapshot["stocks"].items()}}
    save_json(snapshot_path, slim, compact=True)
    save_json(DATA_DIR / "latest.json", today_snapshot, compact=True)

    save_json(ETF_HISTORY_FILE, update_etf_history(today_str, today_snapshot["etfs"]), compact=True)

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

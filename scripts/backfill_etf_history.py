"""
One-off backfill of daily ETF look-through valuations for the past year (data/etf_history.json).

Approximations, shown as such on the dashboard:
- Today's ETF holdings and weights are assumed for the backfilled period.
- Each stock's fundamentals are re-read on its actual point-in-time information arrival dates (SEC filing
  dates, or 60 days after Yahoo period ends since Yahoo has no filing dates) and held until the next filing,
  with no forward interpolation toward future filings.
- ADR share ratios are taken from today's snapshot.

Daily runs append exact, point-in-time rows after `backfilled_until`; re-running this script refreshes only
the backfilled window through `backfilled_until` and never overwrites live daily rows after it.
"""

import os
import sys
import json
import datetime
from concurrent.futures import ThreadPoolExecutor

from data_sources import (fetch_price_history, fetch_sec_companyfacts, facts_as_of, parse_sec_companyfacts,
                          fetch_yahoo_timeseries, parse_yahoo_timeseries, get_sec_ticker_map, repair_with_yahoo)
from valuation_models import compute_dcf, etf_look_through
from fetch_and_evaluate import (model_inputs, holdings_hash, load_json, save_json, update_etf_history, UNIVERSE_FILE, PARAMS_FILE,
                                DATA_DIR, ETF_HISTORY_FILE)

MAX_FILL_DAYS = 14  # carry a price or FX rate over exchange holidays (Lunar New Year closes Asian markets ~9 days)


def sec_checkpoints(facts_data, start_iso, end_iso):
    """Sorted point-in-time dates in [start_iso, end_iso] on which any SEC fact was filed for this company."""
    dates = {start_iso}
    for concepts in (facts_data.get("facts") or {}).values():
        for body in concepts.values():
            for entries in (body.get("units") or {}).values():
                for e in entries:
                    filed = e.get("filed")
                    if filed and start_iso < filed <= end_iso:
                        dates.add(filed)
    return sorted(dates)


def yahoo_checkpoints(ts_data, start_iso, end_iso, report_lag_days=60):
    """Sorted point-in-time dates in [start_iso, end_iso] on which a lagged Yahoo period becomes available."""
    dates = {start_iso}
    lag = datetime.timedelta(days=report_lag_days)
    for res in (ts_data.get("timeseries", {}).get("result") or []):
        t = (res.get("meta", {}).get("type") or [None])[0]
        if not t or t == "trailingMarketCap":
            continue
        for p in (res.get(t) or []):
            d = p.get("asOfDate") if p else None
            if d:
                avail = (datetime.date.fromisoformat(d) + lag).isoformat()
                if start_iso < avail <= end_iso:
                    dates.add(avail)
    return sorted(dates)


def latest_checkpoint_value(by_checkpoint, day_iso):
    """Causal lookup: returns the value at the latest checkpoint on or before `day_iso` (never future)."""
    cp = max((c for c in by_checkpoint if c <= day_iso), default=None)
    return by_checkpoint[cp] if cp is not None else None


def backfill_bounds(today, history, force_through_yesterday=False):
    """
    Returns (start_date, end_date) inclusive for the backfill window.
    When `history["backfilled_until"]` is already set, `end_date` is capped at `backfilled_until` so re-running
    the backfill refreshes only the reconstructed window and never overwrites live daily rows after it.
    """
    earliest_existing = None
    for rows in (history.get("etfs") or {}).values():
        if rows:
            earliest_existing = min(filter(None, [earliest_existing, rows[0][0]]))
    start = datetime.date.fromisoformat(earliest_existing) if earliest_existing else (today - datetime.timedelta(days=365))
    yesterday = today - datetime.timedelta(days=1)
    existing_end = history.get("backfilled_until")
    if existing_end and not force_through_yesterday:
        end = min(datetime.date.fromisoformat(existing_end), yesterday)
    else:
        end = yesterday
    return start, end


def value_on_or_before(series, day):
    for back in range(MAX_FILL_DAYS + 1):
        v = series.get((day - datetime.timedelta(days=back)).isoformat())
        if v is not None:
            return v
    return None


def main():
    today = datetime.datetime.now(datetime.timezone.utc).date()
    history = load_json(ETF_HISTORY_FILE, {"backfilled_until": None, "etfs": {}})
    start, end = backfill_bounds(today, history, force_through_yesterday=bool(os.environ.get("FORCE_BACKFILL_END")))
    params = load_json(PARAMS_FILE, None)
    universe = load_json(UNIVERSE_FILE, {})
    latest = load_json(DATA_DIR / "latest.json", {})
    etfs = {
        etf_id: {**etf_obj, "holdings": (latest.get("etfs", {}).get(etf_id) or {}).get("holdings") or etf_obj.get("holdings", [])}
        for etf_id, etf_obj in universe.get("CUSTOM", {}).items()
    }
    sectors = {
        **{t: s.get("sector") for t, s in latest.get("stocks", {}).items() if s.get("sector")},
        **universe.get("SECTORS", {})
    }
    tickers = sorted({h["ticker"] for e in etfs.values() for h in e.get("holdings", [])})
    print(f"Backfilling {len(etfs)} ETFs over {len(tickers)} holdings from {start} through {end}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        prices = dict(zip(tickers, pool.map(lambda t: fetch_price_history(t, range_="2y"), tickers)))

    # Raw fundamentals once per ticker; parsed as of each month start below
    sec_map = get_sec_ticker_map()
    sec_tickers = [t for t in tickers if t.upper() in sec_map]
    raw_sec = {}
    for t in sec_tickers:
        try:
            facts = fetch_sec_companyfacts(t)
        except Exception as e:
            print(f"  SEC fetch failed for {t}: {e}")
            continue
        # Foreign filers (20-F, IFRS) have no usable US-GAAP facts; like the daily run, use Yahoo for them
        if facts and parse_sec_companyfacts(facts):
            raw_sec[t] = facts
    other = [t for t in tickers if t not in raw_sec]
    with ThreadPoolExecutor(max_workers=4) as pool:
        raw_yahoo = dict(zip(other, pool.map(lambda t: _safe(fetch_yahoo_timeseries, t), other)))

    # The ETFs' own prices feed the dashboard's trend signal and price overlay
    etf_tickers = {etf_id: etf_id.replace("TSE:", "") + (".TO" if etf_id.startswith("TSE:") else "") for etf_id in etfs}
    with ThreadPoolExecutor(max_workers=8) as pool:
        etf_prices = dict(zip(etf_tickers, pool.map(lambda e: fetch_price_history(etf_tickers[e], range_="2y")[1], etf_tickers)))

    start_iso, end_iso = start.isoformat(), end.isoformat()
    adr_ratios = {t: (s.get("valuation") or {}).get("adr_ratio") for t, s in latest.get("stocks", {}).items()}

    # intrinsic[ticker][checkpoint] = (per-share value in reporting currency, reporting currency)
    intrinsic = {}
    for t in tickers:
        intrinsic[t] = {}
        if t in raw_sec:
            cps = sec_checkpoints(raw_sec[t], start_iso, end_iso)
        elif raw_yahoo.get(t):
            cps = yahoo_checkpoints(raw_yahoo[t], start_iso, end_iso)
        else:
            cps = []
        for cp in cps:
            # Record every checkpoint (defaulting to None) so a filing that turns FCF negative or pushes debt
            # above enterprise value clears the prior positive valuation instead of carrying it forward
            intrinsic[t][cp] = None
            if t in raw_sec:
                fund = parse_sec_companyfacts(facts_as_of(raw_sec[t], cp))
                if fund and {"capex_missing", "capex_secondary", "debt_missing",
                             "shares_missing", "shares_mismatch"} & set(fund["warnings"]):
                    # The SEC filing date is already enforced by facts_as_of; align Yahoo to the filed period end
                    if t not in raw_yahoo:
                        raw_yahoo[t] = _safe(fetch_yahoo_timeseries, t)
                    if raw_yahoo[t]:
                        repair_with_yahoo(fund, parse_yahoo_timeseries(
                            raw_yahoo[t], as_of=fund.get("fcf_period_end") or cp, report_lag_days=0))
            else:
                fund = parse_yahoo_timeseries(raw_yahoo[t], as_of=cp)
            inputs, _ = model_inputs(fund, sectors.get(t), params, as_of=cp)
            if not inputs:
                continue
            shares = inputs["shares"] / (adr_ratios.get(t) or 1)
            dcf = compute_dcf(fcf=inputs["fcf"], growth_rate=inputs["growth"], terminal_growth=params["terminal_growth"],
                              wacc=inputs["wacc"], net_debt=inputs["net_debt"], shares=shares,
                              forecast_years=params["forecast_years"])
            if dcf and dcf["intrinsic_value"] > 0:
                intrinsic[t][cp] = (dcf["intrinsic_value"], fund.get("currency", "USD"))

    pairs = {(v[1], prices[t][0]) for t in tickers for v in intrinsic[t].values()
             if v and prices[t][0] and v[1] != prices[t][0]}
    fx = {pair: fetch_price_history(f"{pair[0]}{pair[1]}=X", range_="2y")[1] for pair in pairs}
    print(f"FX pairs: {sorted(pairs)}")

    history = load_json(ETF_HISTORY_FILE, {"backfilled_until": None, "etfs": {}})
    day, last_day = start, None
    while day <= end:
        if day.weekday() < 5:
            day_iso = day.isoformat()
            stocks = {}
            for t in tickers:
                price_ccy, series = prices[t]
                price = value_on_or_before(series, day)
                if price is None:
                    continue
                stocks[t] = {"market_price": price}
                iv = latest_checkpoint_value(intrinsic[t], day_iso)
                if iv:
                    rate = 1.0 if iv[1] == price_ccy else value_on_or_before(fx.get((iv[1], price_ccy), {}), day)
                    if rate:
                        stocks[t]["valuation"] = {"intrinsic_dcf": iv[0] * rate}
            if stocks:
                day_etfs = {etf_id: {**etf_look_through(e.get("holdings", []), stocks),
                                     "holdings_hash": holdings_hash(e.get("holdings", [])),
                                     "market_price": value_on_or_before(etf_prices.get(etf_id, {}), day)}
                            for etf_id, e in etfs.items()}
                history = update_etf_history(day_iso, day_etfs, history)
                last_day = day_iso
        day += datetime.timedelta(days=1)

    if last_day and (not history.get("backfilled_until") or bool(os.environ.get("FORCE_BACKFILL_END"))):
        history["backfilled_until"] = last_day
    save_json(ETF_HISTORY_FILE, history, compact=True)
    print(f"Wrote {ETF_HISTORY_FILE} (backfilled through {history.get('backfilled_until')})")


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


if __name__ == "__main__":
    main()

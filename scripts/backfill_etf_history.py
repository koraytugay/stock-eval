"""
One-off backfill of daily ETF look-through valuations for the past year (data/etf_history.json).

Approximations, shown as such on the dashboard:
- Today's ETF holdings and weights are assumed for the whole period.
- Fundamentals are re-read as of the first day of each month: SEC facts filed by then, or Yahoo periods
  that ended at least 60 days before (Yahoo has no filing dates).
- ADR share ratios are taken from today's snapshot.

Daily runs append exact, point-in-time rows from then on.
"""

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


def month_starts(start, end):
    d = start.replace(day=1)
    while d <= end:
        yield d
        d = (d.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)


def value_on_or_before(series, day):
    for back in range(MAX_FILL_DAYS + 1):
        v = series.get((day - datetime.timedelta(days=back)).isoformat())
        if v is not None:
            return v
    return None


def main():
    today = datetime.datetime.now(datetime.timezone.utc).date()
    history = load_json(ETF_HISTORY_FILE, {"backfilled_until": None, "etfs": {}})
    # If an existing history exists, backfill from its earliest date so all rows are consistently populated
    earliest_existing = None
    for rows in history.get("etfs", {}).values():
        if rows:
            earliest_existing = min(filter(None, [earliest_existing, rows[0][0]]))
    start = datetime.date.fromisoformat(earliest_existing) if earliest_existing else (today - datetime.timedelta(days=365))
    params = load_json(PARAMS_FILE, None)
    universe = load_json(UNIVERSE_FILE, {})
    latest = load_json(DATA_DIR / "latest.json", {})
    etfs = universe.get("CUSTOM", {})
    sectors = universe.get("SECTORS", {})
    tickers = sorted({h["ticker"] for e in etfs.values() for h in e.get("holdings", [])})
    print(f"Backfilling {len(etfs)} ETFs over {len(tickers)} holdings from {start} to {today}")

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

    checkpoints = [d.isoformat() for d in month_starts(start, today)]
    if checkpoints[-1] < today.isoformat():
        checkpoints.append(today.isoformat())
    adr_ratios = {t: (s.get("valuation") or {}).get("adr_ratio") for t, s in latest.get("stocks", {}).items()}

    # intrinsic[ticker][checkpoint] = (per-share value in reporting currency, reporting currency)
    intrinsic = {}
    for t in tickers:
        intrinsic[t] = {}
        for cp in checkpoints:
            if t in raw_sec:
                fund = parse_sec_companyfacts(facts_as_of(raw_sec[t], cp))
                if fund and {"capex_missing", "capex_secondary", "debt_missing",
                             "shares_missing", "shares_mismatch"} & set(fund["warnings"]):
                    # Same Yahoo cross-check as the daily run, read as of the checkpoint
                    if t not in raw_yahoo:
                        raw_yahoo[t] = _safe(fetch_yahoo_timeseries, t)
                    if raw_yahoo[t]:
                        repair_with_yahoo(fund, parse_yahoo_timeseries(raw_yahoo[t], as_of=cp))
            elif raw_yahoo.get(t):
                fund = parse_yahoo_timeseries(raw_yahoo[t], as_of=cp)
            else:
                fund = None
            inputs, _ = model_inputs(fund, sectors.get(t), params)
            if not inputs:
                continue
            shares = inputs["shares"] / (adr_ratios.get(t) or 1)
            dcf = compute_dcf(fcf=inputs["fcf"], growth_rate=inputs["growth"], terminal_growth=params["terminal_growth"],
                              wacc=inputs["wacc"], net_debt=inputs["net_debt"], shares=shares,
                              forecast_years=params["forecast_years"])
            if dcf and dcf["intrinsic_value"] > 0:
                intrinsic[t][cp] = (dcf["intrinsic_value"], fund.get("currency", "USD"))

    pairs = {(ccy, prices[t][0]) for t in tickers for _, ccy in intrinsic[t].values()
             if prices[t][0] and ccy != prices[t][0]}
    fx = {pair: fetch_price_history(f"{pair[0]}{pair[1]}=X", range_="2y")[1] for pair in pairs}
    print(f"FX pairs: {sorted(pairs)}")

    history = load_json(ETF_HISTORY_FILE, {"backfilled_until": None, "etfs": {}})
    day, last_day = start, None
    while day < today:
        if day.weekday() < 5:
            day_iso = day.isoformat()
            cp0 = max((c for c in checkpoints if c <= day_iso), default=None)
            cp1 = min((c for c in checkpoints if c > day_iso), default=None)
            w = 0.0
            if cp0 and cp1:
                d0, d1 = datetime.date.fromisoformat(cp0), datetime.date.fromisoformat(cp1)
                w = (day - d0).days / max((d1 - d0).days, 1)
            stocks = {}
            for t in tickers:
                price_ccy, series = prices[t]
                price = value_on_or_before(series, day)
                if price is None:
                    continue
                stocks[t] = {"market_price": price}
                iv0 = intrinsic[t].get(cp0) if cp0 else None
                iv1 = intrinsic[t].get(cp1) if cp1 else None
                if iv0 and iv1 and iv0[1] == iv1[1]:
                    iv = ((1.0 - w) * iv0[0] + w * iv1[0], iv0[1])
                else:
                    iv = iv0
                if iv:
                    rate = 1.0 if iv[1] == price_ccy else value_on_or_before(fx.get((iv[1], price_ccy), {}), day)
                    if rate:
                        stocks[t]["valuation"] = {"intrinsic_dcf": iv[0] * rate}
            if stocks:
                day_etfs = {etf_id: {**etf_look_through(e.get("holdings", []), stocks),
                                     "holdings_hash": holdings_hash(e.get("holdings", [])),
                                     "market_price": value_on_or_before(etf_prices.get(etf_id, {}), day)}
                            for etf_id, e in etfs.items()}
                history = update_etf_history(day.isoformat(), day_etfs, history)
                last_day = day.isoformat()
        day += datetime.timedelta(days=1)

    history["backfilled_until"] = last_day
    save_json(ETF_HISTORY_FILE, history, compact=True)
    print(f"Wrote {ETF_HISTORY_FILE} (backfilled through {last_day})")


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


if __name__ == "__main__":
    main()

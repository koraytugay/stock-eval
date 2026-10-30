"""
Market and fundamentals data sources:
- Yahoo chart endpoint: market prices and FX rates.
- SEC EDGAR companyfacts: US-listed fundamentals (10-K / 10-Q XBRL).
- Yahoo fundamentals-timeseries: fallback fundamentals for non-SEC tickers (e.g. TSX).

The parse_* functions are pure (no network) so they can be unit tested against fixtures.
All monetary outputs are in billions of the reported currency; shares are in billions.
"""

import os
import ssl
import json
import time
import datetime
import urllib.request

SSL_CTX = ssl.create_default_context()
# SEC requires a descriptive User-Agent with contact details: https://www.sec.gov/os/accessing-edgar-data
# Requests without a contact email are rejected with HTTP 403.
SEC_USER_AGENT_SET = bool(os.environ.get("SEC_USER_AGENT"))
SEC_HEADERS = {"User-Agent": os.environ.get("SEC_USER_AGENT") or "StockEvalApp admin@stockeval-research.org"}
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"}

SCHEMA_VERSION = 3

FCF_FLOW_CONCEPTS = {
    "ocf": ["NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    # Companies switch tags over the years and by industry, so several are tried in priority order. The first
    # two are the standard ones; the rest are industry-specific and get cross-checked against Yahoo.
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment",
              "PaymentsToAcquireProductiveAssets",
              "PaymentsToAcquireOilAndGasPropertyAndEquipment",
              "PaymentsToExploreAndDevelopOilAndGasProperties",
              "PaymentsToAcquireOilAndGasProperty",
              "PaymentsForProceedsFromProductiveAssets",
              "PaymentsForConstructionInProcess",
              "PaymentsToDevelopRealEstateAssets",
              "PaymentsForCapitalImprovements",
              "PaymentsToAcquireOtherProductiveAssets",
              "PaymentsToAcquireOtherPropertyPlantAndEquipment",
              "PaymentsToAcquireMachineryAndEquipment"],
}
PRIMARY_CAPEX_CONCEPTS = 2
INTEREST_PAID_CONCEPTS = ["InterestPaidNet", "InterestPaid"]
CASH_CONCEPTS = ["CashAndCashEquivalentsAtCarryingValue",
                 "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
                 "Cash"]
LT_DEBT_TOTAL_CONCEPTS = ["LongTermDebt", "DebtAndCapitalLeaseObligations",
                          "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"]
LT_DEBT_NONCURRENT_CONCEPTS = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations",
                               "UnsecuredLongTermDebt", "LongTermNotesPayable", "SeniorNotes"]
LT_DEBT_CURRENT_CONCEPTS = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"]
SHORT_TERM_DEBT_CONCEPTS = ["ShortTermBorrowings", "CommercialPaper"]
SHARES_CONCEPTS = [("dei", "EntityCommonStockSharesOutstanding"),
                   ("us-gaap", "CommonStockSharesOutstanding"),
                   ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding")]


def _http_json(url, headers, timeout=10):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _date(s):
    return datetime.date.fromisoformat(s)


def _days(start, end):
    return (_date(end) - _date(start)).days


def _b(v):
    return round(v / 1e9, 3)


# ---------------------------------------------------------------------------
# Yahoo prices / FX
# ---------------------------------------------------------------------------

MINOR_UNIT_CURRENCIES = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}


def fetch_market_price(ticker):
    """Fetch current market price and currency via Yahoo Chart endpoint"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
    try:
        meta = _http_json(url, YAHOO_HEADERS, timeout=8)['chart']['result'][0]['meta']
        price, currency = meta.get('regularMarketPrice'), meta.get('currency', 'USD')
    except Exception:
        return None, None
    # London, Johannesburg and Tel Aviv quote in minor units (pence, cents, agorot)
    if currency in MINOR_UNIT_CURRENCIES and price is not None:
        return price / 100.0, MINOR_UNIT_CURRENCIES[currency]
    return price, currency


def fetch_last_trade_date(ticker="SPY"):
    """Exchange-local date of the ticker's latest trade (so a market holiday shows the prior session), or None."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
    try:
        meta = _http_json(url, YAHOO_HEADERS, timeout=8)['chart']['result'][0]['meta']
        ts = meta['regularMarketTime'] + meta.get('gmtoffset', 0)
        return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date()
    except Exception:
        return None


def fetch_price_history(ticker, range_="1y"):
    """Daily closes as (currency, {iso_date: close}), or (None, {}) on failure. Minor units are converted."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range={range_}"
    try:
        result = _http_json(url, YAHOO_HEADERS, timeout=10)['chart']['result'][0]
        currency = result['meta'].get('currency', 'USD')
        closes = result['indicators']['quote'][0]['close']
        timestamps = result['timestamp']
    except Exception:
        return None, {}
    scale = 100.0 if currency in MINOR_UNIT_CURRENCIES else 1.0
    history = {datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date().isoformat(): c / scale
               for ts, c in zip(timestamps, closes) if c is not None}
    return MINOR_UNIT_CURRENCIES.get(currency, currency), history


_fx_cache = {}

def fetch_fx_rate(from_ccy, to_ccy):
    """Units of to_ccy per 1 from_ccy, or None if unavailable."""
    if not from_ccy or not to_ccy or from_ccy == to_ccy:
        return 1.0
    key = (from_ccy, to_ccy)
    if key not in _fx_cache:
        # One retry: a transient failure must not drop every stock in this currency for the whole run
        rate = fetch_market_price(f"{from_ccy}{to_ccy}=X")[0] or fetch_market_price(f"{from_ccy}{to_ccy}=X")[0]
        if rate is None:
            return None
        _fx_cache[key] = rate
    return _fx_cache[key]


# ---------------------------------------------------------------------------
# SEC EDGAR
# ---------------------------------------------------------------------------

_sec_ticker_map = None

def get_sec_ticker_map():
    global _sec_ticker_map
    if _sec_ticker_map is not None:
        return _sec_ticker_map
    if not SEC_USER_AGENT_SET:
        print("::warning::SEC_USER_AGENT is not set; using a placeholder contact. "
              "The SEC asks clients to identify themselves ('Name email').")
    # Fail hard: silently falling back to Yahoo for every US ticker would degrade the whole snapshot
    data = _http_json("https://www.sec.gov/files/company_tickers.json", SEC_HEADERS)
    _sec_ticker_map = {item['ticker']: str(item['cik_str']).zfill(10) for item in data.values()}
    return _sec_ticker_map


def fetch_sec_companyfacts(ticker):
    """Returns the raw companyfacts JSON, or None if the ticker is not an SEC filer."""
    cik = get_sec_ticker_map().get(ticker.upper())
    if not cik:
        return None
    try:
        return _http_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json", SEC_HEADERS, timeout=20)
    finally:
        time.sleep(0.12)  # Respect SEC 10 requests/sec limit


def _units(facts, taxonomy, concept, unit="USD"):
    return facts.get(taxonomy, {}).get(concept, {}).get("units", {}).get(unit, [])


def _dedupe_latest_filed(entries):
    """One entry per (start, end) period, preferring the most recently filed (handles amendments)."""
    best = {}
    for e in entries:
        key = (e.get("start"), e.get("end"))
        if key not in best or e.get("filed", "") > best[key].get("filed", ""):
            best[key] = e
    return list(best.values())


def _annual_flows(entries):
    """{period_end: entry} for full-year durations reported in 10-K filings."""
    annual = [e for e in entries
              if e.get("start") and str(e.get("form", "")).startswith("10-K")
              and 350 <= _days(e["start"], e["end"]) <= 380]
    return {e["end"]: e for e in _dedupe_latest_filed(annual)}


def _ttm_flow(entries, annual):
    """
    Trailing-twelve-month value = last fiscal year + current YTD - prior-year YTD.
    Cash flow statements in 10-Qs are year-to-date, so this works for OCF and CapEx.
    Returns (value, period_end, filed) or None if no fresher YTD period is available.
    """
    if not annual:
        return None
    fy_end = max(annual)
    flows = _dedupe_latest_filed([e for e in entries if e.get("start")])
    ytd = [e for e in flows
           if str(e.get("form", "")).startswith("10-Q") and e["end"] > fy_end
           and 80 <= _days(e["start"], e["end"]) <= 300
           and abs(_days(fy_end, e["start"]) - 1) <= 10]
    if not ytd:
        return None
    cur = max(ytd, key=lambda e: e["end"])
    cur_len = _days(cur["start"], cur["end"])
    prior = [e for e in flows
             if abs(_days(e["end"], cur["end"]) - 365) <= 10
             and abs(_days(e["start"], e["end"]) - cur_len) <= 10]
    if not prior:
        return None
    prev = max(prior, key=lambda e: e.get("filed", ""))
    return annual[fy_end]["val"] + cur["val"] - prev["val"], cur["end"], cur.get("filed")


def _latest_instant(entries, on_or_before=None, max_age_days=400):
    """Latest point-in-time value, optionally no later than (and not too stale relative to) a date."""
    cands = _dedupe_latest_filed(entries)
    if on_or_before:
        cands = [e for e in cands if e["end"] <= on_or_before and _days(e["end"], on_or_before) <= max_age_days]
    if not cands:
        return None
    return max(cands, key=lambda e: (e["end"], e.get("filed", "")))


def facts_as_of(data, as_of):
    """Copy of a companyfacts payload keeping only facts filed on or before `as_of` (point-in-time view)."""
    facts = {}
    for tax, concepts in data.get("facts", {}).items():
        facts[tax] = {}
        for concept, body in concepts.items():
            units = {u: [e for e in entries if e.get("filed", "") <= as_of]
                     for u, entries in body.get("units", {}).items()}
            facts[tax][concept] = {"units": units}
    return {"facts": facts}


def _reconcile_shares(shares, diluted_entry, warnings, tolerance=3.0):
    """
    Multi-class filers sometimes report the cover-page count for a single class only (e.g. 1,000x too few).
    When it disagrees with the weighted-average diluted count by more than `tolerance`x, trust the latter.
    """
    diluted = diluted_entry["val"] if diluted_entry else None
    if diluted and diluted > 0 and not (1 / tolerance <= shares / diluted <= tolerance):
        warnings.append("shares_mismatch")
        return diluted
    return shares


def parse_sec_companyfacts(data, fetched_at=None):
    """Extracts FCF, net debt and shares from an SEC companyfacts payload."""
    facts = data.get("facts", {})
    gaap = facts.get("us-gaap", {})
    warnings = []

    # --- Free cash flow: OCF and CapEx from the same period ---
    ocf_entries = ocf_annual = None
    for c in FCF_FLOW_CONCEPTS["ocf"]:
        entries = _units(facts, "us-gaap", c)
        annual = _annual_flows(entries)
        if annual:
            ocf_entries, ocf_annual = entries, annual
            break
    if not ocf_annual:
        return None
    fy_end = max(ocf_annual)

    capex_entries, capex_annual = [], {}
    for i, c in enumerate(FCF_FLOW_CONCEPTS["capex"]):
        entries = _units(facts, "us-gaap", c)
        annual = _annual_flows(entries)
        if fy_end in annual:
            capex_entries, capex_annual = entries, annual
            if i >= PRIMARY_CAPEX_CONCEPTS:
                warnings.append("capex_secondary")
            break
    if not capex_annual:
        warnings.append("capex_missing")

    ocf = ocf_annual[fy_end]["val"]
    capex = capex_annual[fy_end]["val"] if fy_end in capex_annual else 0.0
    fcf_end, basis, filed = fy_end, "FY", ocf_annual[fy_end].get("filed")

    ocf_ttm = _ttm_flow(ocf_entries, ocf_annual)
    capex_ttm = _ttm_flow(capex_entries, capex_annual) if capex_annual else None
    if ocf_ttm and (capex_ttm or not capex_annual):
        if not capex_annual or capex_ttm[1] == ocf_ttm[1]:
            ocf = ocf_ttm[0]
            capex = capex_ttm[0] if capex_ttm else 0.0
            fcf_end, basis, filed = ocf_ttm[1], "TTM", ocf_ttm[2]

    # Operating cash flow is after interest paid; the DCF needs it back (see model_inputs)
    interest = None
    for c in INTEREST_PAID_CONCEPTS:
        entries = _units(facts, "us-gaap", c)
        annual = _annual_flows(entries)
        if annual:
            ttm = _ttm_flow(entries, annual) if basis == "TTM" else None
            interest = ttm[0] if ttm else annual[max(annual)]["val"]
            break

    fcf_history = []
    for end in sorted(ocf_annual):
        if capex_annual and end not in capex_annual:
            continue
        cx = capex_annual[end]["val"] if capex_annual else 0.0
        fcf_history.append([end, _b(ocf_annual[end]["val"] - cx)])

    # --- Balance sheet: cash and debt as of the same date ---
    cash_cands = [e for e in (_latest_instant(_units(facts, "us-gaap", c)) for c in CASH_CONCEPTS) if e]
    cash_e = max(cash_cands, key=lambda e: e["end"]) if cash_cands else None
    bs_date = cash_e["end"] if cash_e else fcf_end
    cash = cash_e["val"] if cash_e else 0.0
    if not cash_e:
        warnings.append("cash_missing")

    def instant(concepts):
        for c in concepts:
            e = _latest_instant(_units(facts, "us-gaap", c), bs_date)
            if e:
                return e
        return None

    lt_total = instant(LT_DEBT_TOTAL_CONCEPTS)
    lt_noncur = instant(LT_DEBT_NONCURRENT_CONCEPTS)
    lt_cur = instant(LT_DEBT_CURRENT_CONCEPTS)
    if lt_total and (not lt_noncur or lt_total["end"] >= lt_noncur["end"]):
        lt_debt = lt_total["val"]
    else:
        lt_debt = (lt_noncur["val"] if lt_noncur else 0.0) + (lt_cur["val"] if lt_cur else 0.0)
    st = instant(SHORT_TERM_DEBT_CONCEPTS)
    debt = lt_debt + (st["val"] if st else 0.0)
    if not (lt_total or lt_noncur or lt_cur or st):
        warnings.append("debt_missing")

    # --- Shares: most current source, in preference order ---
    share_cands = []
    for tax, c in SHARES_CONCEPTS:
        e = _latest_instant(_units(facts, tax, c, "shares"))
        if e and e["val"] > 0:
            share_cands.append(e)
    shares = 0.0
    if share_cands:
        newest = max(e["end"] for e in share_cands)
        shares = next(e["val"] for e in share_cands if _days(e["end"], newest) <= 548)
        shares = _reconcile_shares(shares, _latest_instant(_units(facts, "us-gaap",
                                   "WeightedAverageNumberOfDilutedSharesOutstanding", "shares")), warnings)
    else:
        warnings.append("shares_missing")

    return {
        "schema": SCHEMA_VERSION,
        "source": "SEC EDGAR",
        "currency": "USD",
        "fetched_at": fetched_at,
        "filed": filed,
        "fcf_basis": basis,
        "fcf_period_end": fcf_end,
        "balance_sheet_date": bs_date,
        "operating_cash_flow": _b(ocf),
        "capex": _b(capex),
        "free_cash_flow": _b(ocf - capex),
        "interest_paid": _b(interest) if interest is not None else None,
        "total_cash": _b(cash),
        "total_debt": _b(debt),
        "net_debt": _b(debt - cash),
        "shares_outstanding": _b(shares),
        "fcf_history": fcf_history,
        "warnings": warnings
    }


# ---------------------------------------------------------------------------
# Yahoo fundamentals (non-SEC tickers)
# ---------------------------------------------------------------------------

YAHOO_TYPES = [
    "annualOperatingCashFlow", "annualCapitalExpenditure",
    "quarterlyOperatingCashFlow", "quarterlyCapitalExpenditure",
    "trailingOperatingCashFlow", "trailingCapitalExpenditure",
    "annualCashAndCashEquivalents", "quarterlyCashAndCashEquivalents",
    "annualTotalDebt", "quarterlyTotalDebt",
    "annualOrdinarySharesNumber", "quarterlyOrdinarySharesNumber",
    "trailingMarketCap",
]


def fetch_yahoo_timeseries(ticker):
    now = int(time.time())
    url = (f"https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}"
           f"?type={','.join(YAHOO_TYPES)}&period1={now - 7 * 365 * 86400}&period2={now}")
    try:
        return _http_json(url, YAHOO_HEADERS, timeout=10)
    finally:
        time.sleep(0.05)


def parse_yahoo_timeseries(data, fetched_at=None, as_of=None, report_lag_days=60):
    """
    Parses Yahoo fundamentals. With `as_of`, only periods ending at least `report_lag_days` before that date
    are used, approximating what had been reported by then (Yahoo has no filing dates).
    """
    cutoff = None
    if as_of:
        cutoff = (_date(as_of) - datetime.timedelta(days=report_lag_days)).isoformat()
    series = {}
    for res in data.get("timeseries", {}).get("result", []) or []:
        t = (res.get("meta", {}).get("type") or [None])[0]
        points = [p for p in (res.get(t) or []) if p and p.get("reportedValue")
                  and (cutoff is None or p["asOfDate"] <= cutoff)]
        series[t] = sorted(points, key=lambda p: p["asOfDate"])

    def latest(*types):
        for t in types:
            if series.get(t):
                return series[t][-1]
        return None

    val = lambda p: p["reportedValue"]["raw"] if p else 0.0

    # Cash flow, freshest first: sum of the last four quarters (consistent between live and point-in-time
    # reads), Yahoo's own trailing figure, then the last fiscal year
    annual_p = latest("annualOperatingCashFlow")
    quarters = series.get("quarterlyOperatingCashFlow", [])[-4:]
    q_capex = {p["asOfDate"]: p for p in series.get("quarterlyCapitalExpenditure", [])}
    trailing_p = latest("trailingOperatingCashFlow")
    if (len(quarters) == 4 and 250 <= _days(quarters[0]["asOfDate"], quarters[-1]["asOfDate"]) <= 300
            and all(q["asOfDate"] in q_capex for q in quarters)
            and (not annual_p or quarters[-1]["asOfDate"] >= annual_p["asOfDate"])):
        ocf_p, basis = quarters[-1], "TTM"
        ocf = sum(val(q) for q in quarters)
        capex_p = q_capex[quarters[-1]["asOfDate"]]
        capex = sum(abs(val(q_capex[q["asOfDate"]])) for q in quarters)
    elif trailing_p and (not annual_p or trailing_p["asOfDate"] >= annual_p["asOfDate"]):
        ocf_p, basis = trailing_p, "TTM"
        capex_p = latest("trailingCapitalExpenditure", "annualCapitalExpenditure")
        ocf, capex = val(ocf_p), abs(val(capex_p))  # Yahoo reports CapEx as a negative cash flow
    elif annual_p:
        ocf_p, basis = annual_p, "FY"
        capex_p = latest("annualCapitalExpenditure")
        ocf, capex = val(ocf_p), abs(val(capex_p))
    else:
        return None

    cash_p = latest("quarterlyCashAndCashEquivalents", "annualCashAndCashEquivalents")
    debt_p = latest("quarterlyTotalDebt", "annualTotalDebt")
    shares_p = latest("quarterlyOrdinarySharesNumber", "annualOrdinarySharesNumber")
    mcap_p = latest("trailingMarketCap")

    warnings = [w for w, p in (("capex_missing", capex_p), ("cash_missing", cash_p),
                               ("debt_missing", debt_p), ("shares_missing", shares_p)) if not p]

    cash, debt = val(cash_p), val(debt_p)

    capex_by_date = {p["asOfDate"]: abs(p["reportedValue"]["raw"]) for p in series.get("annualCapitalExpenditure", [])}
    fcf_history = [[p["asOfDate"], _b(p["reportedValue"]["raw"] - capex_by_date[p["asOfDate"]])]
                   for p in series.get("annualOperatingCashFlow", []) if p["asOfDate"] in capex_by_date]

    return {
        "schema": SCHEMA_VERSION,
        "source": "Yahoo Finance",
        "currency": ocf_p.get("currencyCode", "USD"),
        "fetched_at": fetched_at,
        "filed": None,
        "fcf_basis": basis,
        "fcf_period_end": ocf_p["asOfDate"],
        "balance_sheet_date": cash_p["asOfDate"] if cash_p else None,
        "operating_cash_flow": _b(ocf),
        "capex": _b(capex),
        "free_cash_flow": _b(ocf - capex),
        "total_cash": _b(cash),
        "total_debt": _b(debt),
        "net_debt": _b(debt - cash),
        "shares_outstanding": _b(val(shares_p)),
        # Used to infer the ADR ratio for US-listed foreign companies
        "market_cap": _b(val(mcap_p)) if mcap_p else None,
        "market_cap_currency": mcap_p.get("currencyCode") if mcap_p else None,
        "fcf_history": fcf_history,
        "warnings": warnings
    }


def repair_with_yahoo(record, yahoo):
    """
    Fills gaps in an SEC record from the Yahoo equivalent: missing or industry-tag capex (the larger figure is
    kept, since understating capex is the risky error) and missing debt. Returns True if a field was repaired.
    """
    if not yahoo:
        return False
    warnings = record["warnings"]
    repaired = False
    same_basis = (yahoo["fcf_basis"] == record["fcf_basis"]
                  and abs(_days(yahoo["fcf_period_end"], record["fcf_period_end"])) <= 100)
    if ("capex_missing" in warnings or "capex_secondary" in warnings) and same_basis and yahoo["capex"] > 0:
        if yahoo["capex"] > record["capex"]:
            record["capex"] = yahoo["capex"]
            record["free_cash_flow"] = _b((record["operating_cash_flow"] - record["capex"]) * 1e9)
            record["fcf_history"] = yahoo["fcf_history"]
            repaired = True
        if "capex_missing" in warnings:
            warnings.remove("capex_missing")
            repaired = True
        warnings.append("capex_from_yahoo" if repaired else "capex_checked")
    if "debt_missing" in warnings and "debt_missing" not in yahoo["warnings"]:
        record["total_debt"] = yahoo["total_debt"]
        record["net_debt"] = _b((yahoo["total_debt"] - record["total_cash"]) * 1e9)
        warnings.remove("debt_missing")
        warnings.append("debt_from_yahoo")
        repaired = True
    return repaired


def fetch_fundamentals(ticker, fetched_at):
    """SEC for US filers, Yahoo timeseries otherwise. Returns a parsed record or None."""
    sec_map = get_sec_ticker_map()  # raises if the SEC is unreachable or rejects our User-Agent
    is_sec_filer = ticker.upper() in sec_map
    try:
        facts = fetch_sec_companyfacts(ticker)
        if facts:
            parsed = parse_sec_companyfacts(facts, fetched_at)
            if parsed:
                needs_check = {"capex_missing", "capex_secondary", "debt_missing"} & set(parsed["warnings"])
                if needs_check:
                    try:
                        yahoo = parse_yahoo_timeseries(fetch_yahoo_timeseries(ticker), fetched_at)
                    except Exception as e:
                        print(f"  Yahoo cross-check failed for {ticker}: {e}")
                        yahoo = None
                    repair_with_yahoo(parsed, yahoo)
                return parsed
    except Exception as e:
        print(f"  SEC fetch failed for {ticker}: {e}")
    try:
        record = parse_yahoo_timeseries(fetch_yahoo_timeseries(ticker), fetched_at)
    except Exception as e:
        print(f"  Yahoo fundamentals failed for {ticker}: {e}")
        return None
    if record and is_sec_filer:
        # FCF definition and TTM/FY basis can differ from the SEC figures; make the substitution visible
        record["warnings"] = record.get("warnings", []) + ["sec_fallback"]
    return record

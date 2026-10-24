"""
Core Data Extraction and Valuation Pipeline:
1. Loads universe (SP500, QQQ, XIC, Custom ETFs).
2. Retrieves audited 10-K fundamentals and current market prices.
3. Computes Forward DCF and Reverse DCF (implied growth rate).
4. Aggregates look-through intrinsic valuation for ETFs.
5. Saves daily raw snapshot to data/snapshots/YYYY-MM-DD.json and data/latest.json.
"""

import os
import json
import ssl
import time
import datetime
import urllib.request
from pathlib import Path
from valuation_models import compute_dcf, compute_reverse_dcf

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SNAPSHOTS_DIR = DATA_DIR / "snapshots"
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
UNIVERSE_FILE = DATA_DIR / "universe" / "universe.json"
CACHE_FILE = DATA_DIR / "fundamentals_cache.json"

SSL_CTX = ssl.create_default_context()
SEC_HEADERS = {"User-Agent": "StockEvalApp admin@stockeval-research.org"}
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"}

# Load SEC ticker mapping
_sec_ticker_map = None

def get_sec_ticker_map():
    global _sec_ticker_map
    if _sec_ticker_map is not None:
        return _sec_ticker_map
    try:
        url = "https://www.sec.gov/files/company_tickers.json"
        req = urllib.request.Request(url, headers=SEC_HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            _sec_ticker_map = {item['ticker']: str(item['cik_str']).zfill(10) for item in data.values()}
            return _sec_ticker_map
    except Exception as e:
        print(f"Warning: Failed to fetch SEC ticker map: {e}")
        return {}

def fetch_market_price(ticker):
    """Fetch current market price and currency via Yahoo Chart endpoint"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
    req = urllib.request.Request(url, headers=YAHOO_HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
            data = json.loads(resp.read().decode())
            meta = data['chart']['result'][0]['meta']
            price = meta.get('regularMarketPrice')
            currency = meta.get('currency', 'USD')
            return price, currency
    except Exception as e:
        return None, "USD"

def fetch_sec_fundamentals(ticker):
    """Pulls OCF, CapEx, Debt, Cash, and Shares from SEC EDGAR API"""
    ticker_map = get_sec_ticker_map()
    cik = ticker_map.get(ticker.upper())
    if not cik:
        return None

    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    req = urllib.request.Request(url, headers=SEC_HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            gaap = data.get('facts', {}).get('us-gaap', {})

            # 1. Operating Cash Flow
            ocf_units = gaap.get('NetCashProvidedByUsedInOperatingActivities', {}).get('units', {}).get('USD', [])
            annual_ocf = [u for u in ocf_units if u.get('form') == '10-K' and u.get('fp') == 'FY']
            ocf = sorted(annual_ocf, key=lambda x: x.get('end'))[-1]['val'] if annual_ocf else 0.0

            # 2. CapEx
            capex_units = gaap.get('PaymentsToAcquirePropertyPlantAndEquipment', {}).get('units', {}).get('USD', [])
            annual_capex = [u for u in capex_units if u.get('form') == '10-K' and u.get('fp') == 'FY']
            capex = sorted(annual_capex, key=lambda x: x.get('end'))[-1]['val'] if annual_capex else 0.0

            # 3. Shares
            shares_units = gaap.get('CommonStockSharesOutstanding', {}).get('units', {}).get('shares', [])
            shares = sorted(shares_units, key=lambda x: x.get('end'))[-1]['val'] if shares_units else 0.0

            # 4. Cash and Equivalents
            cash_units = gaap.get('CashAndCashEquivalentsAtCarryingValue', {}).get('units', {}).get('USD', [])
            cash = sorted(cash_units, key=lambda x: x.get('end'))[-1]['val'] if cash_units else 0.0

            # 5. Debt
            debt_units = gaap.get('LongTermDebtNoncurrent', {}).get('units', {}).get('USD', [])
            debt = sorted(debt_units, key=lambda x: x.get('end'))[-1]['val'] if debt_units else 0.0

            # Convert to billions
            fcf = (ocf - capex) / 1e9
            net_debt = (debt - cash) / 1e9

            return {
                "operating_cash_flow": round(ocf / 1e9, 3),
                "capex": round(capex / 1e9, 3),
                "free_cash_flow": round(fcf, 3),
                "total_cash": round(cash / 1e9, 3),
                "total_debt": round(debt / 1e9, 3),
                "net_debt": round(net_debt, 3),
                "shares_outstanding": round(shares / 1e9, 3),
                "source": "SEC EDGAR"
            }
    except Exception as e:
        return None

def load_fundamentals_cache():
    if CACHE_FILE.exists():
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {}

def save_fundamentals_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)

def run_daily_evaluation():
    print(f"[{datetime.datetime.now().isoformat()}] Starting daily evaluation...")
    today_str = datetime.date.today().isoformat()

    # Load Universe
    if not UNIVERSE_FILE.exists():
        import update_universe
        update_universe.update_all_universes()
    
    with open(UNIVERSE_FILE, "r") as f:
        universe_data = json.load(f)

    sp500_tickers = universe_data.get("SP500", {}).get("tickers", [])
    qqq_tickers = universe_data.get("QQQ", {}).get("tickers", [])
    xic_tickers = universe_data.get("XIC", {}).get("tickers", [])
    custom_etfs = universe_data.get("CUSTOM", {})

    all_tickers = sorted(list(set(sp500_tickers + qqq_tickers + xic_tickers)))
    # Add any extra tickers from custom ETFs
    for etf_id, etf_obj in custom_etfs.items():
        for item in etf_obj.get("holdings", []):
            t = item.get("ticker")
            if t and t not in all_tickers:
                all_tickers.append(t)

    print(f"Total unique constituents in universe: {len(all_tickers)}")

    cache = load_fundamentals_cache()
    today_snapshot = {
        "date": today_str,
        "timestamp": datetime.datetime.now().isoformat(),
        "stocks": {},
        "etfs": {}
    }

    # Process Stocks
    for idx, ticker in enumerate(all_tickers, 1):
        price, currency = fetch_market_price(ticker)
        if price is None:
            continue

        # Get fundamentals (cache or SEC)
        fund = cache.get(ticker)
        if not fund:
            fund = fetch_sec_fundamentals(ticker)
            if fund:
                cache[ticker] = fund
                time.sleep(0.12) # Respect SEC 10 requests/sec limit
        
        # Determine index membership
        indices = []
        if ticker in sp500_tickers: indices.append("SP500")
        if ticker in qqq_tickers: indices.append("QQQ")
        if ticker in xic_tickers: indices.append("XIC")

        stock_entry = {
            "ticker": ticker,
            "currency": currency,
            "market_price": price,
            "indices": indices,
            "raw": fund or {}
        }

        # Run Models if fundamentals are available
        if fund and fund.get("shares_outstanding", 0) > 0:
            fcf = fund.get("free_cash_flow", 0.0)
            shares = fund.get("shares_outstanding", 1.0)
            net_debt = fund.get("net_debt", 0.0)

            dcf_res = compute_dcf(
                fcf=fcf,
                growth_rate=0.06 if "QQQ" in indices else 0.04,
                wacc=0.08,
                terminal_growth=0.025,
                net_debt=net_debt,
                shares=shares
            )

            reverse_g = compute_reverse_dcf(
                market_price=price,
                fcf=fcf,
                shares=shares,
                net_debt=net_debt,
                wacc=0.08
            )

            if dcf_res:
                intrinsic = dcf_res["intrinsic_value"]
                discount_pct = round(((price - intrinsic) / intrinsic) * 100.0, 2) if intrinsic > 0 else None
                stock_entry["valuation"] = {
                    "intrinsic_dcf": intrinsic,
                    "market_premium_pct": discount_pct,
                    "implied_growth_reverse_dcf": reverse_g,
                    "wacc": dcf_res["wacc"],
                    "growth_rate_assumed": dcf_res["growth_rate"]
                }

        today_snapshot["stocks"][ticker] = stock_entry

    save_fundamentals_cache(cache)

    # Evaluate Custom ETFs Look-Through
    for etf_id, etf_obj in custom_etfs.items():
        holdings = etf_obj.get("holdings", [])
        total_weight = sum(h.get("weight", 0) for h in holdings)
        weighted_intrinsic = 0.0
        weighted_price = 0.0
        covered_weight = 0.0

        for h in holdings:
            t = h.get("ticker")
            w = h.get("weight", 0)
            stock_info = today_snapshot["stocks"].get(t)
            if stock_info:
                p = stock_info.get("market_price", 0.0)
                intrin = stock_info.get("valuation", {}).get("intrinsic_dcf", p)
                weighted_price += p * w
                weighted_intrinsic += intrin * w
                covered_weight += w

        today_snapshot["etfs"][etf_id] = {
            "name": etf_obj.get("name", etf_id),
            "currency": etf_obj.get("currency", "CAD"),
            "holdings_count": len(holdings),
            "covered_weight_pct": round((covered_weight / total_weight) * 100, 1) if total_weight > 0 else 0,
            "weighted_intrinsic_dcf": round(weighted_intrinsic, 2),
            "weighted_market_price": round(weighted_price, 2),
            "holdings": holdings
        }

    # Save Snapshot
    snapshot_path = SNAPSHOTS_DIR / f"{today_str}.json"
    with open(snapshot_path, "w") as f:
        json.dump(today_snapshot, f, indent=2)

    # Save latest.json for web dashboard
    latest_path = DATA_DIR / "latest.json"
    with open(latest_path, "w") as f:
        json.dump(today_snapshot, f, indent=2)

    # Update history index
    index_path = DATA_DIR / "history_index.json"
    history = []
    if index_path.exists():
        with open(index_path, "r") as f:
            history = json.load(f)
    if today_str not in history:
        history.append(today_str)
        history.sort()
    with open(index_path, "w") as f:
        json.dump(history, f, indent=2)

    print(f"Evaluation complete! Saved {len(today_snapshot['stocks'])} stocks and {len(today_snapshot['etfs'])} ETFs to {snapshot_path}")

if __name__ == "__main__":
    run_daily_evaluation()

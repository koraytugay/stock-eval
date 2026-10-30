"""
ETF holdings resolution for the custom ETF look-through:
- Fetches published top holdings from stockanalysis.com (free pages list roughly the top 10-25).
- Converts their symbols to Yahoo Finance tickers.
- Expands funds of funds (e.g. XEQT) into the holdings of the underlying ETFs.
- Looks up sectors for tickers outside the index universe via Yahoo search.

Weights are fractions of the top-level fund, so the sum of resolved weights is the share of the fund
that is actually covered by the look-through.
"""

import re
import json
import time
import urllib.request

from data_sources import SSL_CTX, YAHOO_HEADERS

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"}

# stockanalysis.com exchange codes -> Yahoo Finance ticker suffixes
EXCHANGE_SUFFIX = {
    "TSX": ".TO", "TSXV": ".V", "NEO": ".NE", "OTC": "",
    "LON": ".L", "AMS": ".AS", "EPA": ".PA", "ETR": ".DE", "FRA": ".F", "SWX": ".SW", "BIT": ".MI",
    "BME": ".MC", "EBR": ".BR", "ELI": ".LS", "ISE": ".IR", "VIE": ".VI", "STO": ".ST", "CPH": ".CO",
    "HEL": ".HE", "OSL": ".OL", "WSE": ".WA",
    "TYO": ".T", "HKG": ".HK", "ASX": ".AX", "NZE": ".NZ", "SGX": ".SI", "KRX": ".KS", "KOSDAQ": ".KQ",
    "TPE": ".TW", "TPEX": ".TWO", "NSE": ".NS", "BOM": ".BO", "SHA": ".SS", "SHE": ".SZ", "IDX": ".JK",
    "SET": ".BK", "KLSE": ".KL", "JSE": ".JO", "BVMF": ".SA", "BMV": ".MX", "TADAWUL": ".SR", "TLV": ".TA",
}

# Secondary GDR/cross-listings mapped to primary home-exchange tickers
SYMBOL_ALIASES = {
    "@FRA-SSU": "005930.KS",
    "@FRA-HBC2": "HSBA.L",
}

# Yahoo sector names -> GICS sector names used in config/model_params.json
YAHOO_TO_GICS = {
    "Technology": "Information Technology", "Financial Services": "Financials", "Healthcare": "Health Care",
    "Consumer Cyclical": "Consumer Discretionary", "Consumer Defensive": "Consumer Staples",
    "Basic Materials": "Materials", "Communication Services": "Communication Services",
    "Industrials": "Industrials", "Energy": "Energy", "Utilities": "Utilities", "Real Estate": "Real Estate",
}

FUND_NAME_PATTERN = re.compile(r"\b(ETF|Index Fund)\b", re.IGNORECASE)
ROW_PATTERN = re.compile(r'\{no:\d+,s:"([^"]*)",n:"([^"]*)",holdingWeight:(-?[\d.e-]+)')


def fetch_page_holdings(page):
    """Returns [(symbol, name, weight_fraction)] from a stockanalysis.com holdings page, or None."""
    url = f"https://stockanalysis.com/{page}/holdings/"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=15) as resp:
            html = resp.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"  holdings page {page} unavailable: {e}")
        return None
    finally:
        time.sleep(0.5)
    rows = [(s, n, float(w) / 100.0) for s, n, w in ROW_PATTERN.findall(html)]
    return rows or None


def to_yahoo(symbol):
    """'$BRK.B' -> 'BRK-B', '@TYO-7203' -> '7203.T', '@HKG-700' -> '0700.HK'; None for cash/unknown."""
    if symbol in SYMBOL_ALIASES:
        return SYMBOL_ALIASES[symbol]
    if symbol.startswith(("$", "#")):
        return symbol[1:].replace(".", "-")
    if symbol.startswith("@") and "-" in symbol:
        exchange, code = symbol[1:].split("-", 1)
        if exchange not in EXCHANGE_SUFFIX:
            return None
        if exchange == "HKG":
            code = code.zfill(4)
        return code.replace(".", "-") + EXCHANGE_SUFFIX[exchange]
    return None


def fund_page(symbol, aliases):
    """stockanalysis.com page path for a fund holding, e.g. '@TSX-XIC' -> 'quote/tsx/XIC', '#ITOT' -> 'etf/itot'."""
    key = symbol.lstrip("$#@")
    if key in aliases:
        return aliases[key]
    if symbol.startswith("@") and "-" in symbol:
        exchange, code = key.split("-", 1)
        return f"quote/{exchange.lower()}/{code}"
    return f"etf/{key.lower()}"


def resolve_holdings(page, aliases, weight=1.0, depth=0, max_depth=2):
    """Flattens a fund's published holdings into {yahoo_ticker: {"weight", "name"}} scaled by `weight`."""
    rows = fetch_page_holdings(page)
    if not rows:
        return {}
    resolved = {}
    for symbol, name, w in rows:
        if w <= 0:
            continue
        child = None
        if FUND_NAME_PATTERN.search(name) and depth < max_depth:
            child = resolve_holdings(fund_page(symbol, aliases), aliases, weight * w, depth + 1, max_depth)
        if child:
            for t, h in child.items():
                entry = resolved.setdefault(t, {"weight": 0.0, "name": h["name"]})
                entry["weight"] += h["weight"]
            continue
        ticker = to_yahoo(symbol)
        if ticker and not FUND_NAME_PATTERN.search(name):
            entry = resolved.setdefault(ticker, {"weight": 0.0, "name": name})
            entry["weight"] += weight * w
    return resolved


def fetch_yahoo_sector(ticker):
    url = f"https://query2.finance.yahoo.com/v1/finance/search?q={ticker}&quotesCount=1&newsCount=0"
    try:
        req = urllib.request.Request(url, headers=YAHOO_HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
            quotes = json.loads(resp.read().decode()).get("quotes") or []
    except Exception:
        return None
    finally:
        time.sleep(0.1)
    match = next((q for q in quotes if q.get("symbol", "").upper() == ticker.upper()), None)
    return YAHOO_TO_GICS.get((match or {}).get("sector"))

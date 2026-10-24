"""
Script to fetch and cache universe lists:
- S&P 500 (SPY)
- Nasdaq 100 (QQQ)
- S&P/TSX Capped Composite (XIC) - large-cap proxy list
- Custom user-defined ETFs (from config/custom_etfs.json)

Also records a GICS sector per ticker (used for sector WACC). If a remote list cannot be fetched,
the previously saved list is reused so a transient outage does not shrink the universe.
"""

import csv
import json
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "custom_etfs.json"
DATA_UNIVERSE = BASE_DIR / "data" / "universe"
UNIVERSE_FILE = DATA_UNIVERSE / "universe.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# Prominent S&P/TSX Composite constituents with their GICS sectors
XIC_TICKERS = {
    "RY.TO": "Financials", "TD.TO": "Financials", "ENB.TO": "Energy", "CNR.TO": "Industrials",
    "CP.TO": "Industrials", "BNS.TO": "Financials", "BMO.TO": "Financials", "ATD.TO": "Consumer Staples",
    "TRP.TO": "Energy", "CNQ.TO": "Energy", "SU.TO": "Energy", "TRI.TO": "Industrials",
    "CSU.TO": "Information Technology", "BCE.TO": "Communication Services", "MFC.TO": "Financials",
    "SLF.TO": "Financials", "WCN.TO": "Industrials", "ABX.TO": "Materials", "NTR.TO": "Materials",
    "IMO.TO": "Energy", "QSR.TO": "Consumer Discretionary", "T.TO": "Communication Services",
    "RCI-B.TO": "Communication Services", "GIB-A.TO": "Information Technology", "FTS.TO": "Utilities",
    "DOL.TO": "Consumer Staples", "POW.TO": "Financials", "WPM.TO": "Materials",
    "MG.TO": "Consumer Discretionary", "OTEX.TO": "Information Technology", "L.TO": "Consumer Staples",
    "WN.TO": "Consumer Staples", "CCL-B.TO": "Materials", "TIH.TO": "Industrials",
    "SAP.TO": "Consumer Staples", "CTC-A.TO": "Consumer Discretionary", "EMA.TO": "Utilities",
    "FNV.TO": "Materials", "K.TO": "Materials", "FM.TO": "Materials", "TECK-B.TO": "Materials",
    "CVE.TO": "Energy", "TOU.TO": "Energy", "ARX.TO": "Energy", "AEM.TO": "Materials",
}


def _fetch_csv(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return list(csv.DictReader(resp.read().decode('utf-8').splitlines()))


def fetch_sp500():
    """Returns {ticker: sector} for the S&P 500, or None on failure."""
    url = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv"
    try:
        rows = _fetch_csv(url)
        tickers = {row['Symbol'].replace('.', '-'): row.get('GICS Sector') for row in rows if row.get('Symbol')}
        if len(tickers) > 400:
            return tickers
        print(f"SP500 dataset looked incomplete ({len(tickers)} rows)")
    except Exception as e:
        print(f"Error fetching SP500 from dataset: {e}")
    return None


def fetch_qqq():
    """Returns {ticker: sector-ish label} for the Nasdaq 100, or None on failure."""
    url = "https://raw.githubusercontent.com/Gary-Strauss/NASDAQ100_Constituents/master/data/nasdaq100_constituents.csv"
    try:
        rows = _fetch_csv(url)
        tickers = {row['Ticker'].replace('.', '-'): row.get('GICS_Sector') for row in rows if row.get('Ticker')}
        if len(tickers) > 80:
            return tickers
        print(f"QQQ dataset looked incomplete ({len(tickers)} rows)")
    except Exception as e:
        print(f"Error fetching QQQ: {e}")
    return None


def load_custom_etfs():
    """Load user-defined ETFs from config/custom_etfs.json"""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r") as f:
            return json.load(f).get("etfs", {})
    return {}


def load_previous_universe():
    if UNIVERSE_FILE.exists():
        with open(UNIVERSE_FILE, "r") as f:
            return json.load(f)
    return {}


def update_all_universes():
    DATA_UNIVERSE.mkdir(parents=True, exist_ok=True)
    previous = load_previous_universe()
    prev_sectors = previous.get("SECTORS", {})

    def resolve(name, fetched):
        if fetched is not None:
            return list(fetched), fetched
        prev = previous.get(name, {}).get("tickers", [])
        if not prev:
            raise SystemExit(f"Could not fetch {name} constituents and no previous universe to fall back on")
        print(f"Reusing previous {name} list ({len(prev)} tickers)")
        return prev, {t: prev_sectors.get(t) for t in prev}

    sp500, sp500_sectors = resolve("SP500", fetch_sp500())
    qqq, qqq_sectors = resolve("QQQ", fetch_qqq())
    xic = list(XIC_TICKERS)
    custom_etfs = load_custom_etfs()

    # S&P dataset uses true GICS sectors; QQQ dataset labels are often industries, so they rank last
    sectors = {}
    for mapping in (qqq_sectors, XIC_TICKERS, sp500_sectors):
        sectors.update({t: s for t, s in mapping.items() if s})

    universe = {
        "SP500": {"name": "S&P 500 Index", "tickers": sp500},
        "QQQ": {"name": "Invesco QQQ (Nasdaq 100)", "tickers": qqq},
        "XIC": {"name": "S&P/TSX Composite (large-cap proxy)", "tickers": xic},
        "CUSTOM": custom_etfs,
        "SECTORS": sectors
    }

    with open(UNIVERSE_FILE, "w") as f:
        json.dump(universe, f, indent=2)

    print(f"Updated universe: SP500={len(sp500)}, QQQ={len(qqq)}, XIC={len(xic)}, Custom ETFs={len(custom_etfs)}")


if __name__ == "__main__":
    update_all_universes()

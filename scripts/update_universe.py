"""
Script to fetch and cache universe lists:
- S&P 500 (SPY)
- Nasdaq 100 (QQQ)
- S&P/TSX Capped Composite (XIC)
- S&P 500 High Dividend (SPYD)
- Custom user-defined ETFs (from config/custom_etfs.json)
"""

import json
import urllib.request
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "custom_etfs.json"
DATA_UNIVERSE = BASE_DIR / "data" / "universe"
DATA_UNIVERSE.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def fetch_sp500():
    """Fetch all ~503 S&P 500 tickers from validated GitHub dataset"""
    url = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            lines = resp.read().decode('utf-8').splitlines()
            import csv
            reader = csv.DictReader(lines)
            tickers = [row['Symbol'].replace('.', '-') for row in reader if row.get('Symbol')]
            if len(tickers) > 400:
                return tickers
    except Exception as e:
        print(f"Error fetching SP500 from dataset: {e}")
    
    # Fallback list if offline
    return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B", "JPM", "V", "JNJ", "PG", "HD", "XOM"]

def fetch_qqq():
    """Fetch QQQ (Nasdaq 100) tickers from automated dataset"""
    url = "https://raw.githubusercontent.com/Gary-Strauss/NASDAQ100_Constituents/master/data/nasdaq100_constituents.csv"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            lines = resp.read().decode('utf-8').splitlines()
            import csv
            reader = csv.DictReader(lines)
            tickers = [row['Ticker'].replace('.', '-') for row in reader if row.get('Ticker')]
            if len(tickers) > 80:
                return tickers
    except Exception as e:
        print(f"Error fetching QQQ: {e}")
    return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "COST", "PEP", "CSCO"]

def fetch_xic_tsx():
    """Prominent S&P/TSX composite tickers"""
    # High-coverage list of top 60-100 TSX components
    return [
        "RY.TO", "TD.TO", "ENB.TO", "CNR.TO", "CP.TO", "BNS.TO", "BMO.TO", "ATD.TO", "TRP.TO",
        "CNQ.TO", "SU.TO", "TRI.TO", "CSU.TO", "BCE.TO", "MFC.TO", "SLF.TO", "WCN.TO", "ABX.TO",
        "NTR.TO", "IMO.TO", "QSR.TO", "T.TO", "RCI-B.TO", "GIB-A.TO", "FTS.TO", "DOL.TO", "POW.TO",
        "WPM.TO", "MG.TO", "OTEX.TO", "L.TO", "WN.TO", "CCL-B.TO", "TIH.TO", "SAP.TO", "CTC-A.TO",
        "EMA.TO", "FNV.TO", "K.TO", "FM.TO", "TECK-B.TO", "CVE.TO", "TOU.TO", "ARX.TO", "AEM.TO"
    ]

def load_custom_etfs():
    """Load user-defined ETFs from config/custom_etfs.json"""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r") as f:
            data = json.load(f)
            return data.get("etfs", {})
    return {}

def update_all_universes():
    sp500 = fetch_sp500()
    qqq = fetch_qqq()
    xic = fetch_xic_tsx()
    custom_etfs = load_custom_etfs()

    universe = {
        "SP500": {"name": "S&P 500 Index", "tickers": sp500},
        "QQQ": {"name": "Invesco QQQ (Nasdaq 100)", "tickers": qqq},
        "XIC": {"name": "iShares Core S&P/TSX Capped Composite", "tickers": xic},
        "CUSTOM": custom_etfs
    }

    out_file = DATA_UNIVERSE / "universe.json"
    with open(out_file, "w") as f:
        json.dump(universe, f, indent=2)

    print(f"Updated universe: SP500={len(sp500)}, QQQ={len(qqq)}, XIC={len(xic)}, Custom ETFs={len(custom_etfs)}")

if __name__ == "__main__":
    update_all_universes()

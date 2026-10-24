import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import etf_holdings
from etf_holdings import to_yahoo, fund_page, resolve_holdings


class ToYahooTest(unittest.TestCase):
    def test_symbols(self):
        self.assertEqual(to_yahoo("$NVDA"), "NVDA")
        self.assertEqual(to_yahoo("$BRK.B"), "BRK-B")
        self.assertEqual(to_yahoo("@TSX-RY"), "RY.TO")
        self.assertEqual(to_yahoo("@TYO-7203"), "7203.T")
        self.assertEqual(to_yahoo("@HKG-700"), "0700.HK")
        self.assertEqual(to_yahoo("@LON-BT.A"), "BT-A.L")
        self.assertEqual(to_yahoo("@OTC-CICHF"), "CICHF")
        self.assertIsNone(to_yahoo("=n/a"))
        self.assertIsNone(to_yahoo("@XYZ-ABC"))

    def test_fund_pages(self):
        self.assertEqual(fund_page("@TSX-XIC", {}), "quote/tsx/XIC")
        self.assertEqual(fund_page("#ITOT", {}), "etf/itot")
        self.assertEqual(fund_page("@TSX-XTOT", {"TSX-XTOT": "etf/itot"}), "etf/itot")


class ResolveHoldingsTest(unittest.TestCase):
    def test_expands_fund_of_funds(self):
        pages = {
            "quote/tsx/TOP": [("@TSX-SUB", "Sub Index ETF", 0.6), ("$AAPL", "Apple Inc.", 0.3),
                              ("=n/a", "CAD - Cash", 0.1)],
            "quote/tsx/SUB": [("$AAPL", "Apple Inc.", 0.5), ("@TSX-RY", "Royal Bank", 0.25)],
        }
        with mock.patch.object(etf_holdings, "fetch_page_holdings", side_effect=lambda p: pages.get(p)):
            res = resolve_holdings("quote/tsx/TOP", {})
        self.assertAlmostEqual(res["AAPL"]["weight"], 0.3 + 0.6 * 0.5)
        self.assertAlmostEqual(res["RY.TO"]["weight"], 0.6 * 0.25)
        self.assertEqual(set(res), {"AAPL", "RY.TO"})


if __name__ == "__main__":
    unittest.main()

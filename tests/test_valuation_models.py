import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from valuation_models import compute_dcf, compute_reverse_dcf, estimate_growth, etf_look_through


class ComputeDcfTest(unittest.TestCase):
    def test_known_value(self):
        # Zero growth, 10% WACC, zero terminal growth: EV is a perpetuity of FCF / WACC
        res = compute_dcf(fcf=10.0, growth_rate=0.0, terminal_growth=0.0, wacc=0.10, net_debt=20.0, shares=8.0)
        self.assertAlmostEqual(res["enterprise_value"], 100.0, places=2)
        self.assertAlmostEqual(res["intrinsic_value"], 10.0, places=2)

    def test_not_applicable(self):
        self.assertIsNone(compute_dcf(fcf=-1.0, shares=1.0))
        self.assertIsNone(compute_dcf(fcf=0.0, shares=1.0))
        self.assertIsNone(compute_dcf(fcf=1.0, shares=0.0))
        self.assertIsNone(compute_dcf(fcf=1.0, shares=1.0, wacc=0.02, terminal_growth=0.025))


class ReverseDcfTest(unittest.TestCase):
    def test_round_trip_recovers_growth(self):
        for g in (-0.2, 0.0, 0.04, 0.12, 0.35):
            fwd = compute_dcf(fcf=5.0, growth_rate=g, wacc=0.08, terminal_growth=0.025, net_debt=12.0, shares=2.0)
            rev = compute_reverse_dcf(market_price=fwd["intrinsic_value"], fcf=5.0, shares=2.0, net_debt=12.0, wacc=0.08)
            self.assertEqual(rev["status"], "ok")
            self.assertAlmostEqual(rev["growth"], g, places=3)

    def test_out_of_range(self):
        self.assertEqual(compute_reverse_dcf(1e6, fcf=1.0, shares=1.0, net_debt=0.0)["status"], "above_range")
        self.assertEqual(compute_reverse_dcf(0.01, fcf=1.0, shares=1.0, net_debt=0.0)["status"], "below_range")
        # Net cash exceeding market cap gives a non-positive target EV
        self.assertEqual(compute_reverse_dcf(1.0, fcf=1.0, shares=1.0, net_debt=-5.0)["status"], "below_range")

    def test_not_applicable(self):
        self.assertIsNone(compute_reverse_dcf(10.0, fcf=-1.0, shares=1.0, net_debt=0.0))


class EstimateGrowthTest(unittest.TestCase):
    def test_cagr(self):
        hist = [["2020-12-31", 100.0], ["2021-12-31", 110.0], ["2022-12-31", 121.0], ["2023-12-31", 133.1]]
        g, src = estimate_growth(hist, cap=0.5)
        self.assertEqual(src, "historical")
        self.assertAlmostEqual(g, 0.10, places=2)

    def test_clamped(self):
        hist = [["2020-12-31", 1.0], ["2023-12-31", 100.0]]
        self.assertEqual(estimate_growth(hist, cap=0.15), (0.15, "historical"))
        hist = [["2020-12-31", 100.0], ["2023-12-31", 50.0]]
        self.assertEqual(estimate_growth(hist, floor=0.0), (0.0, "historical"))

    def test_fallbacks(self):
        self.assertEqual(estimate_growth([], default=0.04), (0.04, "default"))
        self.assertEqual(estimate_growth([["2022-12-31", 1.0], ["2023-12-31", 2.0]], default=0.04), (0.04, "default"))
        self.assertEqual(estimate_growth([["2019-12-31", -1.0], ["2023-12-31", 2.0]], default=0.04), (0.04, "default"))


class EtfLookThroughTest(unittest.TestCase):
    def test_weighted_by_value_and_skips_unvalued(self):
        stocks = {
            "A": {"market_price": 100.0, "valuation": {"intrinsic_dcf": 50.0}},   # 0.5 intrinsic per $1
            "B": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 20.0}},    # 2.0 intrinsic per $1
            "C": {"market_price": 30.0},                                          # unvalued
        }
        holdings = [{"ticker": "A", "weight": 0.25}, {"ticker": "B", "weight": 0.25},
                    {"ticker": "C", "weight": 0.25}, {"ticker": "MISSING", "weight": 0.25}]
        res = etf_look_through(holdings, stocks)
        self.assertEqual(res["covered_weight_pct"], 50.0)
        self.assertAlmostEqual(res["intrinsic_per_dollar"], 1.25)
        self.assertAlmostEqual(res["market_premium_pct"], -20.0)

    def test_nothing_valued(self):
        res = etf_look_through([{"ticker": "X", "weight": 1.0}], {"X": {"market_price": 5.0}})
        self.assertEqual(res["covered_weight_pct"], 0.0)
        self.assertIsNone(res["intrinsic_per_dollar"])


if __name__ == "__main__":
    unittest.main()

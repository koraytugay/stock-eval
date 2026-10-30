import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from valuation_models import (compute_dcf, compute_reverse_dcf, estimate_growth, normalized_fcf, etf_look_through,
                              infer_adr_ratio)


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

    def test_robust_to_one_outlier_year(self):
        # A spike in the final year would dominate a point-to-point CAGR
        hist = [["2019-12-31", 100.0], ["2020-12-31", 105.0], ["2021-12-31", 110.0],
                ["2022-12-31", 116.0], ["2023-12-31", 300.0]]
        g, _ = estimate_growth(hist, cap=1.0)
        cagr = (300.0 / 100.0) ** 0.25 - 1
        self.assertLess(g, cagr - 0.1)

    def test_clamped(self):
        hist = [["2020-12-31", 1.0], ["2021-12-31", 10.0], ["2023-12-31", 100.0]]
        self.assertEqual(estimate_growth(hist, cap=0.15), (0.15, "historical"))
        hist = [["2020-12-31", 100.0], ["2021-12-31", 80.0], ["2023-12-31", 50.0]]
        self.assertEqual(estimate_growth(hist, floor=0.0), (0.0, "historical"))

    def test_fallbacks(self):
        self.assertEqual(estimate_growth([], default=0.04), (0.04, "default"))
        self.assertEqual(estimate_growth([["2022-12-31", 1.0], ["2023-12-31", 2.0]], default=0.04), (0.04, "default"))
        self.assertEqual(estimate_growth([["2019-12-31", 1.0], ["2021-12-31", -1.0], ["2023-12-31", 2.0]], default=0.04),
                         (0.04, "default"))
        # Three points spanning under min_years
        self.assertEqual(estimate_growth([["2022-01-31", 1.0], ["2022-12-31", 2.0], ["2023-06-30", 3.0]], default=0.04),
                         (0.04, "default"))

    def test_three_consecutive_annual_points_qualify_for_min_years_3(self):
        # 3 annual points (2.0 years between endpoints) represent 3 fiscal years of history
        hist = [["2022-12-31", 100.0], ["2023-12-31", 120.0], ["2024-12-31", 144.0]]
        g, src = estimate_growth(hist, default=0.04, cap=0.25, min_years=3)
        self.assertEqual(src, "historical")
        self.assertAlmostEqual(g, 0.20, places=2)

    def test_ttm_period_end_rolls_growth_window_smoothly(self):
        # 6 annual points where year 1 was low (50) and years 2..6 were flat (100)
        hist = [["2019-12-31", 50.0], ["2020-12-31", 80.0], ["2021-12-31", 100.0],
                ["2022-12-31", 100.0], ["2023-12-31", 100.0], ["2024-12-31", 100.0]]
        g_fy, _ = estimate_growth(hist, cap=0.5, basis="FY")
        g_q2, _ = estimate_growth(hist, cap=0.5, latest_fcf=100.0, period_end="2025-06-30", basis="TTM")
        g_next_fy, _ = estimate_growth(hist + [["2025-12-31", 100.0]], cap=0.5, basis="FY")
        self.assertGreater(g_fy, g_q2)
        self.assertGreater(g_q2, g_next_fy)


class NormalizedFcfTest(unittest.TestCase):
    HIST = [["2021-12-31", 3.0], ["2022-12-31", 6.0], ["2023-12-31", 9.0]]

    def test_fy_basis_averages_last_years(self):
        self.assertEqual(normalized_fcf(9.0, self.HIST, "FY", 3), 6.0)
        self.assertEqual(normalized_fcf(9.0, self.HIST, "FY", 2), 7.5)

    def test_ttm_basis_includes_all_fiscal_years_before_it(self):
        self.assertEqual(normalized_fcf(12.0, self.HIST, "TTM", 3), 9.0)

    def test_ttm_period_end_rolls_normalization_window_smoothly(self):
        # At FY end (6.0) vs full year later (8.0 for latest=9.0), mid-year TTM blends halfway (~7.0)
        n_fy = normalized_fcf(9.0, self.HIST, "FY", 3, period_end="2023-12-31")
        n_q2 = normalized_fcf(9.0, self.HIST, "TTM", 3, period_end="2024-06-30")
        n_next = normalized_fcf(9.0, self.HIST + [["2024-12-31", 9.0]], "FY", 3, period_end="2024-12-31")
        self.assertEqual(n_fy, 6.0)
        self.assertAlmostEqual(n_q2, 7.0, places=1)
        self.assertEqual(n_next, 8.0)

    def test_disabled_and_short_history(self):
        self.assertEqual(normalized_fcf(9.0, self.HIST, "FY", 1), 9.0)
        self.assertEqual(normalized_fcf(4.0, [], "TTM", 3), 4.0)
        self.assertIsNone(normalized_fcf(None, self.HIST))


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

    def test_non_positive_value_is_excluded_as_debt_exceeds_value(self):
        stocks = {"A": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 20.0}},
                  "B": {"market_price": 10.0, "valuation_status": "debt_exceeds_value",
                        "valuation": {"intrinsic_dcf": 0.0}}}
        res = etf_look_through([{"ticker": "A", "weight": 0.5}, {"ticker": "B", "weight": 0.5}], stocks)
        self.assertEqual(res["covered_weight_pct"], 50.0)
        self.assertEqual(res["unvalued_weight_pct"], {"debt_exceeds_value": 50.0})
        self.assertAlmostEqual(res["intrinsic_per_dollar"], 2.0)
        self.assertAlmostEqual(res["market_premium_pct"], -50.0)

    def test_partial_holdings_list_measures_coverage_against_whole_fund(self):
        stocks = {"A": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 5.0}},
                  "B": {"market_price": 10.0}}
        res = etf_look_through([{"ticker": "A", "weight": 0.2}, {"ticker": "B", "weight": 0.1}], stocks)
        self.assertEqual(res["listed_weight_pct"], 30.0)
        self.assertEqual(res["covered_weight_pct"], 20.0)
        self.assertAlmostEqual(res["intrinsic_per_dollar"], 0.5)

    def test_nothing_valued(self):
        res = etf_look_through([{"ticker": "X", "weight": 1.0}], {"X": {"market_price": 5.0}})
        self.assertEqual(res["covered_weight_pct"], 0.0)
        self.assertIsNone(res["intrinsic_per_dollar"])


class AdrRatioTest(unittest.TestCase):
    def test_snaps_to_common_ratio(self):
        # Market cap 275B over 5.54B ordinary shares = ~49.6/share; receipt at 108 represents 2 shares
        self.assertEqual(infer_adr_ratio(108.18, 274.3, 5.542), 2)
        self.assertEqual(infer_adr_ratio(23.5, 258.9, 11.256), 1)
        self.assertEqual(infer_adr_ratio(4.9, 100.0, 2.0), 0.1)
        # 5:1 ADRs trading at an ADR premium (e.g. TSM at ~16% premium -> raw ~5.8) snap to 5, not 6
        self.assertEqual(infer_adr_ratio(431.81, 1932.16, 25.932), 5)

    def test_unusable_inputs(self):
        self.assertIsNone(infer_adr_ratio(10.0, None, 1.0))
        self.assertIsNone(infer_adr_ratio(10.0, 5.0, 0.0))


class ImpliedGrowthBoundsTest(unittest.TestCase):
    def test_out_of_range_holdings_count_at_the_bound(self):
        stocks = {
            "A": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 10.0, "implied_growth_reverse_dcf": 0.10,
                                                      "implied_growth_status": "ok"}},
            "B": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 10.0, "implied_growth_reverse_dcf": None,
                                                      "implied_growth_status": "above_range"}},
        }
        holdings = [{"ticker": "A", "weight": 0.5}, {"ticker": "B", "weight": 0.5}]
        # (10% + 150%) / 2 = 80%, not 10% from dropping B
        self.assertEqual(etf_look_through(holdings, stocks)["implied_growth_pct"], 80.0)


class UnvaluedBreakdownTest(unittest.TestCase):
    def test_reasons_are_reported_as_share_of_fund(self):
        stocks = {
            "A": {"market_price": 10.0, "valuation": {"intrinsic_dcf": 10.0}},
            "B": {"market_price": 10.0, "valuation_status": "sector_excluded"},
            "C": {"market_price": 10.0, "valuation_status": "negative_fcf"},
        }
        holdings = [{"ticker": t, "weight": w} for t, w in (("A", 0.4), ("B", 0.3), ("C", 0.1), ("D", 0.2))]
        r = etf_look_through(holdings, stocks)
        self.assertEqual(r["unvalued_weight_pct"], {"sector_excluded": 30.0, "no_price": 20.0, "negative_fcf": 10.0})
        self.assertEqual(r["covered_weight_pct"], 40.0)


if __name__ == "__main__":
    unittest.main()

import sys
import datetime
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fetch_and_evaluate as fe
import data_sources as ds
from data_sources import SCHEMA_VERSION

TODAY = datetime.date(2026, 10, 30)
PARAMS = {"fundamentals_cache": {"stale_after_days": 30, "max_refresh_per_run": 10}}


def entry(fetched_at, **extra):
    return {"schema": SCHEMA_VERSION, "source": "SEC EDGAR", "fetched_at": fetched_at, **extra}


class FailedFetchTest(unittest.TestCase):
    def test_failure_keeps_good_data(self):
        cache = {"AAA": entry("2026-09-01", free_cash_flow=5.0)}
        with mock.patch.object(fe, "fetch_fundamentals", return_value=None):
            fe.refresh_fundamentals(["AAA"], cache, TODAY, PARAMS)
        self.assertEqual(cache["AAA"]["free_cash_flow"], 5.0)
        self.assertEqual(cache["AAA"]["source"], "SEC EDGAR")
        self.assertFalse(fe.is_stale(cache["AAA"], TODAY, 30))  # not retried again the same day
        self.assertTrue(fe.is_stale(cache["AAA"], TODAY + datetime.timedelta(days=1), 30))

    def test_failure_without_prior_data_is_negative_cached(self):
        cache = {}
        with mock.patch.object(fe, "fetch_fundamentals", return_value=None):
            fe.refresh_fundamentals(["BBB"], cache, TODAY, PARAMS)
        self.assertIsNone(cache["BBB"]["source"])

    def test_success_replaces(self):
        cache = {"AAA": entry("2026-09-01", free_cash_flow=5.0)}
        with mock.patch.object(fe, "fetch_fundamentals", return_value=entry("2026-10-30", free_cash_flow=7.0)):
            fe.refresh_fundamentals(["AAA"], cache, TODAY, PARAMS)
        self.assertEqual(cache["AAA"]["free_cash_flow"], 7.0)


FILING = {"lag_days": 116, "window_days": 60, "recheck_days": 3}


class FilingWindowTest(unittest.TestCase):
    def test_recheck_inside_window(self):
        e = entry("2026-10-24", fcf_period_end="2026-06-30")  # window opens Oct 24
        self.assertTrue(fe.is_stale(e, TODAY, 30, FILING, "AAA"))

    def test_no_recheck_before_window(self):
        e = entry("2026-10-20", fcf_period_end="2026-09-30")  # next report not due until late January
        self.assertFalse(fe.is_stale(e, TODAY, 30, FILING, "AAA"))

    def test_recent_check_inside_window_waits(self):
        e = entry("2026-10-29", fcf_period_end="2026-06-30")
        self.assertFalse(fe.is_stale(e, TODAY, 30, FILING, "AAA"))

    def test_window_ends(self):
        e = entry("2026-10-20", fcf_period_end="2026-03-31")  # window over; falls back to the age limit
        self.assertFalse(fe.is_stale(e, TODAY, 30, FILING, "AAA"))

    def test_age_limit_is_staggered(self):
        e = entry("2026-09-25", fcf_period_end="2026-09-15")
        ages = {fe.is_stale(e, TODAY, 30, None, t) for t in ("A", "B", "C", "D", "E", "F", "G", "H")}
        self.assertEqual(ages, {True, False})


class MarketClosedTest(unittest.TestCase):
    def test_open_day(self):
        self.assertFalse(fe.is_market_closed_today(TODAY, TODAY))  # Friday, traded today

    def test_holiday(self):
        self.assertTrue(fe.is_market_closed_today(TODAY, TODAY - datetime.timedelta(days=1)))

    def test_weekend(self):
        sat = datetime.date(2026, 10, 31)
        self.assertTrue(fe.is_market_closed_today(sat, TODAY))

    def test_unknown_is_not_closed(self):
        self.assertFalse(fe.is_market_closed_today(TODAY, None))


class SecFallbackTest(unittest.TestCase):
    def test_yahoo_fallback_for_sec_filer_is_flagged(self):
        with mock.patch.object(ds, "get_sec_ticker_map", return_value={"AAA": "1"}), \
             mock.patch.object(ds, "fetch_sec_companyfacts", side_effect=RuntimeError("boom")), \
             mock.patch.object(ds, "fetch_yahoo_timeseries", return_value={}), \
             mock.patch.object(ds, "parse_yahoo_timeseries", side_effect=lambda *a, **k: {"source": "Yahoo Finance", "warnings": []}):
            self.assertIn("sec_fallback", ds.fetch_fundamentals("AAA", "2026-10-30")["warnings"])
            self.assertNotIn("sec_fallback", ds.fetch_fundamentals("ZZZ.TO", "2026-10-30")["warnings"])


class FreshnessTest(unittest.TestCase):
    STOCKS = {
        "A": {"valuation": {"ok": 1}, "raw": {"fcf_period_end": "2026-09-30"}},
        "B": {"valuation": {"ok": 1}, "raw": {"fcf_period_end": "2026-03-31", "warnings": ["sec_fallback"]}},
        "C": {"raw": {"fcf_period_end": "2020-01-01"}},  # not valued: ignored
    }

    def test_summary(self):
        fr = fe.freshness_summary(self.STOCKS, TODAY)
        self.assertEqual(fr["valued"], 2)
        self.assertEqual(fr["oldest_period_end"], "2026-03-31")
        self.assertEqual(fr["older_count"], 1)
        self.assertEqual(fr["sec_fallback_count"], 1)

    def test_etf_as_of_is_weighted(self):
        holdings = [{"ticker": "A", "weight": 0.75}, {"ticker": "B", "weight": 0.25}, {"ticker": "C", "weight": 0.5}]
        d = datetime.date.fromisoformat(fe.etf_fundamentals_as_of(holdings, self.STOCKS))
        self.assertTrue(datetime.date(2026, 8, 1) < d < datetime.date(2026, 9, 30))


VALUE_PARAMS = {
    "forecast_years": 5, "terminal_growth": 0.025, "default_wacc": 0.08, "sector_wacc": {},
    "excluded_sectors": ["Financials"], "fcf_normalization_years": 1,
    "growth": {"default": 0.04, "floor": 0.0, "cap": 0.15, "min_history_years": 3,
               "latest_base_min_growth": 0.05, "latest_base_max_spike": 1.5},
    "interest": {"tax_rate": 0.25, "assumed_cost_of_debt": 0.04},
}
FUND = {"source": "SEC EDGAR", "currency": "USD", "free_cash_flow": 10.0, "fcf_basis": "FY", "fcf_history": [],
        "net_debt": 5.0, "shares_outstanding": 2.0}


class ValueStockTest(unittest.TestCase):
    def value(self, fund, sector="Information Technology", price=100.0):
        return fe.value_stock("AAA", price, "USD", fund, sector, VALUE_PARAMS)

    def test_ok(self):
        valuation, status = self.value(FUND)
        self.assertEqual(status, "ok")
        self.assertGreater(valuation["intrinsic_dcf"], 0)
        self.assertEqual(valuation["growth_source"], "default")

    def test_excluded_sector(self):
        self.assertEqual(self.value(FUND, "Financials"), (None, "sector_excluded"))

    def test_missing_data_statuses(self):
        self.assertEqual(self.value({})[1], "no_fundamentals")
        self.assertEqual(self.value({**FUND, "shares_outstanding": None})[1], "no_shares")
        self.assertEqual(self.value({**FUND, "free_cash_flow": -1.0})[1], "negative_fcf")

    def test_debt_exceeding_value_is_floored(self):
        valuation, status = self.value({**FUND, "net_debt": 10_000.0})
        self.assertEqual(status, "debt_exceeds_value")
        self.assertEqual(valuation["intrinsic_dcf"], 0.0)
        self.assertIsNone(valuation["market_premium_pct"])


def sec_record(**kw):
    rec = {"fcf_basis": "TTM", "fcf_period_end": "2026-09-30", "operating_cash_flow": 20.0, "capex": 0.0,
           "free_cash_flow": 20.0, "total_cash": 2.0, "total_debt": 0.0, "net_debt": -2.0, "fcf_history": [],
           "warnings": ["capex_missing", "debt_missing"]}
    rec.update(kw)
    return rec


YAHOO = {"fcf_basis": "TTM", "fcf_period_end": "2026-09-30", "capex": 11.0, "total_debt": 23.0,
         "fcf_history": [["2025-12-31", 9.0]], "warnings": []}


class YahooRepairTest(unittest.TestCase):
    def test_fills_capex_and_debt(self):
        rec = sec_record()
        self.assertTrue(ds.repair_with_yahoo(rec, dict(YAHOO)))
        self.assertEqual(rec["capex"], 11.0)
        self.assertEqual(rec["free_cash_flow"], 9.0)
        self.assertEqual(rec["net_debt"], 21.0)
        self.assertEqual(rec["fcf_history"], [["2025-12-31", 9.0]])
        self.assertNotIn("capex_missing", rec["warnings"])
        self.assertNotIn("debt_missing", rec["warnings"])

    def test_keeps_larger_sec_capex(self):
        rec = sec_record(capex=15.0, free_cash_flow=5.0, warnings=["capex_secondary"])
        ds.repair_with_yahoo(rec, dict(YAHOO))
        self.assertEqual(rec["capex"], 15.0)

    def test_different_basis_leaves_capex_missing(self):
        rec = sec_record(fcf_basis="FY", warnings=["capex_missing"])
        ds.repair_with_yahoo(rec, dict(YAHOO))
        self.assertIn("capex_missing", rec["warnings"])

    def test_no_yahoo_data(self):
        self.assertFalse(ds.repair_with_yahoo(sec_record(), None))

    def test_unrepaired_capex_means_no_valuation(self):
        self.assertEqual(ValueStockTest().value({**FUND, "warnings": ["capex_missing"]})[1], "no_capex")


class SharesReconcileTest(unittest.TestCase):
    def test_consistent_counts_kept(self):
        w = []
        self.assertEqual(ds._reconcile_shares(1.0e9, {"val": 1.1e9}, w), 1.0e9)
        self.assertEqual(w, [])

    def test_single_class_count_replaced(self):
        w = []
        self.assertEqual(ds._reconcile_shares(1.4e6, {"val": 2.2e9}, w), 2.2e9)
        self.assertEqual(w, ["shares_mismatch"])

    def test_no_diluted_data(self):
        self.assertEqual(ds._reconcile_shares(5.0, None, []), 5.0)


class CoverageDropTest(unittest.TestCase):
    HISTORY = {"etfs": {"X": [["2026-10-29", 1.0, 5.0, 40.0, 10.0]], "Y": [["2026-10-29", 1.0, 5.0, 40.0, 10.0]]}}

    def test_flags_big_drop_only(self):
        etfs = {"X": {"covered_weight_pct": 30.0}, "Y": {"covered_weight_pct": 39.0}, "Z": {"covered_weight_pct": 1.0}}
        self.assertEqual(fe.coverage_drops(etfs, self.HISTORY), [("X", 40.0, 30.0)])


class InterestAddbackTest(unittest.TestCase):
    def test_reported_interest_is_added_back_after_tax(self):
        inputs, _ = fe.model_inputs({**FUND, "interest_paid": 2.0}, "Utilities", VALUE_PARAMS)
        self.assertEqual(inputs["interest_addback"], 1.5)
        self.assertEqual(inputs["fcf"], 11.5)

    def test_estimated_from_debt_when_not_reported(self):
        inputs, _ = fe.model_inputs({**FUND, "total_debt": 100.0}, "Utilities", VALUE_PARAMS)
        self.assertEqual(inputs["interest_addback"], 3.0)  # 100 * 4% * (1 - 25%)

    def test_no_debt_no_addback(self):
        inputs, _ = fe.model_inputs(FUND, "Utilities", VALUE_PARAMS)
        self.assertEqual(inputs["interest_addback"], 0.0)

    def test_negative_levered_fcf_rescued_by_interest(self):
        fund = {**FUND, "free_cash_flow": -1.0, "interest_paid": 4.0}
        inputs, status = fe.model_inputs(fund, "Utilities", VALUE_PARAMS)
        self.assertEqual(status, "ok")
        self.assertEqual(inputs["fcf"], 2.0)


class GrowerBaseTest(unittest.TestCase):
    PARAMS = {**VALUE_PARAMS, "fcf_normalization_years": 3}

    def fund(self, history, latest):
        return {**FUND, "fcf_basis": "TTM", "free_cash_flow": latest, "fcf_history": history}

    def test_grower_uses_latest(self):
        hist = [["2022-12-31", 6.0], ["2023-12-31", 7.2], ["2024-12-31", 8.6], ["2025-12-31", 10.4]]
        inputs, _ = fe.model_inputs(self.fund(hist, 12.0), "Information Technology", self.PARAMS)
        self.assertEqual(inputs["fcf"], 12.0)

    def test_spike_stays_normalized(self):
        hist = [["2022-12-31", 6.0], ["2023-12-31", 7.2], ["2024-12-31", 8.6], ["2025-12-31", 10.4]]
        inputs, _ = fe.model_inputs(self.fund(hist, 30.0), "Information Technology", self.PARAMS)
        self.assertLess(inputs["fcf"], 20.0)

    def test_flat_company_stays_normalized(self):
        hist = [["2022-12-31", 10.0], ["2023-12-31", 10.0], ["2024-12-31", 10.0], ["2025-12-31", 10.0]]
        inputs, _ = fe.model_inputs(self.fund(hist, 11.0), "Information Technology", self.PARAMS)
        self.assertLess(inputs["fcf"], 11.0)


if __name__ == "__main__":
    unittest.main()

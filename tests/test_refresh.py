import sys
import datetime
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fetch_and_evaluate as fe
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


if __name__ == "__main__":
    unittest.main()

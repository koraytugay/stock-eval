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


if __name__ == "__main__":
    unittest.main()

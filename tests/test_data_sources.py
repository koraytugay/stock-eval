import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from data_sources import parse_sec_companyfacts, parse_yahoo_timeseries


def fact(val, end, form, filed, start=None):
    e = {"val": val, "end": end, "form": form, "filed": filed}
    if start:
        e["start"] = start
    return e


def usd(*entries):
    return {"units": {"USD": list(entries)}}


def shares(*entries):
    return {"units": {"shares": list(entries)}}


B = 1e9

SEC_FIXTURE = {"facts": {
    "dei": {"EntityCommonStockSharesOutstanding": shares(fact(2 * B, "2024-04-20", "10-Q", "2024-05-01"))},
    "us-gaap": {
        "NetCashProvidedByUsedInOperatingActivities": usd(
            fact(8 * B, "2022-12-31", "10-K", "2023-02-01", "2022-01-01"),
            fact(10 * B, "2023-12-31", "10-K", "2024-02-01", "2023-01-01"),
            # Amended 10-K restating FY2023 must win over the original
            fact(11 * B, "2023-12-31", "10-K/A", "2024-03-01", "2023-01-01"),
            fact(2 * B, "2023-03-31", "10-Q", "2023-04-30", "2023-01-01"),
            fact(3 * B, "2024-03-31", "10-Q", "2024-04-30", "2024-01-01"),
        ),
        "PaymentsToAcquirePropertyPlantAndEquipment": usd(
            fact(1 * B, "2022-12-31", "10-K", "2023-02-01", "2022-01-01"),
            fact(2 * B, "2023-12-31", "10-K", "2024-02-01", "2023-01-01"),
            fact(0.5 * B, "2023-03-31", "10-Q", "2023-04-30", "2023-01-01"),
            fact(0.5 * B, "2024-03-31", "10-Q", "2024-04-30", "2024-01-01"),
        ),
        "CashAndCashEquivalentsAtCarryingValue": usd(
            fact(4 * B, "2023-12-31", "10-K", "2024-02-01"),
            fact(5 * B, "2024-03-31", "10-Q", "2024-04-30"),
        ),
        "LongTermDebtNoncurrent": usd(fact(6 * B, "2024-03-31", "10-Q", "2024-04-30")),
        "LongTermDebtCurrent": usd(fact(1 * B, "2024-03-31", "10-Q", "2024-04-30")),
        "CommercialPaper": usd(fact(0.5 * B, "2024-03-31", "10-Q", "2024-04-30")),
        # Stale debt figure from long before the balance sheet date is ignored
        "ShortTermBorrowings": usd(fact(9 * B, "2019-12-31", "10-K", "2020-02-01")),
    },
}}


class ParseSecTest(unittest.TestCase):
    def setUp(self):
        self.r = parse_sec_companyfacts(SEC_FIXTURE, "2024-05-02")

    def test_ttm_fcf(self):
        # OCF TTM = 11 + 3 - 2 = 12; CapEx TTM = 2 + 0.5 - 0.5 = 2
        self.assertEqual(self.r["fcf_basis"], "TTM")
        self.assertEqual(self.r["fcf_period_end"], "2024-03-31")
        self.assertEqual(self.r["operating_cash_flow"], 12.0)
        self.assertEqual(self.r["capex"], 2.0)
        self.assertEqual(self.r["free_cash_flow"], 10.0)
        self.assertEqual(self.r["filed"], "2024-04-30")

    def test_history_uses_amended_values(self):
        self.assertEqual(self.r["fcf_history"], [["2022-12-31", 7.0], ["2023-12-31", 9.0]])

    def test_balance_sheet(self):
        self.assertEqual(self.r["balance_sheet_date"], "2024-03-31")
        self.assertEqual(self.r["total_cash"], 5.0)
        # Noncurrent + current + commercial paper (stale ShortTermBorrowings is skipped)
        self.assertEqual(self.r["total_debt"], 7.5)
        self.assertEqual(self.r["net_debt"], 2.5)

    def test_shares_from_dei(self):
        self.assertEqual(self.r["shares_outstanding"], 2.0)
        self.assertEqual(self.r["warnings"], [])

    def test_fy_fallback_and_missing_fields(self):
        data = {"facts": {"us-gaap": {
            "NetCashProvidedByUsedInOperatingActivities": usd(fact(5 * B, "2023-12-31", "10-K", "2024-02-01", "2023-01-01")),
            "WeightedAverageNumberOfDilutedSharesOutstanding": shares(
                fact(3 * B, "2023-12-31", "10-K", "2024-02-01", "2023-01-01")),
        }}}
        r = parse_sec_companyfacts(data)
        self.assertEqual(r["fcf_basis"], "FY")
        self.assertEqual(r["free_cash_flow"], 5.0)
        self.assertEqual(r["shares_outstanding"], 3.0)
        self.assertIn("capex_missing", r["warnings"])
        self.assertIn("debt_missing", r["warnings"])

    def test_no_cash_flow_data(self):
        self.assertIsNone(parse_sec_companyfacts({"facts": {"us-gaap": {}}}))


def ts(type_, *points):
    return {"meta": {"type": [type_]},
            type_: [{"asOfDate": d, "currencyCode": "USD", "reportedValue": {"raw": v}} for d, v in points]}


class ParseYahooTest(unittest.TestCase):
    def test_parse(self):
        data = {"timeseries": {"result": [
            ts("annualOperatingCashFlow", ("2022-12-31", 3 * B), ("2023-12-31", 4 * B)),
            ts("annualCapitalExpenditure", ("2022-12-31", -1 * B), ("2023-12-31", -1 * B)),
            ts("trailingOperatingCashFlow", ("2024-06-30", 5 * B)),
            ts("trailingCapitalExpenditure", ("2024-06-30", -2 * B)),
            ts("quarterlyCashAndCashEquivalents", ("2024-06-30", 1 * B)),
            ts("quarterlyTotalDebt", ("2024-06-30", 4 * B)),
            ts("quarterlyOrdinarySharesNumber", ("2024-06-30", 0.5 * B)),
        ]}}
        r = parse_yahoo_timeseries(data, "2024-07-01")
        self.assertEqual(r["currency"], "USD")
        self.assertEqual(r["fcf_basis"], "TTM")
        self.assertEqual(r["free_cash_flow"], 3.0)
        self.assertEqual(r["net_debt"], 3.0)
        self.assertEqual(r["shares_outstanding"], 0.5)
        self.assertEqual(r["fcf_history"], [["2022-12-31", 2.0], ["2023-12-31", 3.0]])

    def test_quarterly_ttm_and_point_in_time(self):
        data = {"timeseries": {"result": [
            ts("annualOperatingCashFlow", ("2023-12-31", 8 * B)),
            ts("annualCapitalExpenditure", ("2023-12-31", -2 * B)),
            ts("quarterlyOperatingCashFlow", ("2023-09-30", 2 * B), ("2023-12-31", 2 * B),
               ("2024-03-31", 3 * B), ("2024-06-30", 3 * B), ("2024-09-30", 4 * B)),
            ts("quarterlyCapitalExpenditure", ("2023-09-30", -1 * B), ("2023-12-31", -1 * B),
               ("2024-03-31", -1 * B), ("2024-06-30", -1 * B), ("2024-09-30", -1 * B)),
            ts("quarterlyOrdinarySharesNumber", ("2024-09-30", 1 * B)),
        ]}}
        live = parse_yahoo_timeseries(data)
        self.assertEqual((live["fcf_basis"], live["fcf_period_end"]), ("TTM", "2024-09-30"))
        self.assertEqual(live["free_cash_flow"], 12.0 - 4.0)
        # By 2024-09-01 the June quarter is known (60-day reporting lag), the September one is not
        past = parse_yahoo_timeseries(data, as_of="2024-09-01")
        self.assertEqual(past["fcf_period_end"], "2024-06-30")
        self.assertEqual(past["free_cash_flow"], 10.0 - 4.0)
        # Earlier still, fewer than four quarters after the annual report: fall back to the fiscal year
        early = parse_yahoo_timeseries(data, as_of="2024-03-15")
        self.assertEqual((early["fcf_basis"], early["free_cash_flow"]), ("FY", 6.0))

    def test_trailing_market_cap_not_lagged_by_report_lag(self):
        data = {"timeseries": {"result": [
            ts("annualOperatingCashFlow", ("2023-12-31", 8 * B)),
            ts("annualCapitalExpenditure", ("2023-12-31", -2 * B)),
            ts("quarterlyOrdinarySharesNumber", ("2023-12-31", 1 * B)),
            ts("trailingMarketCap", ("2023-10-01", 100 * B), ("2024-08-15", 150 * B)),
        ]}}
        r = parse_yahoo_timeseries(data, as_of="2024-09-01")
        self.assertEqual(r["market_cap"], 150.0)

    def test_same_date_as_annual_is_fy_not_ttm(self):
        # When trailing or 4-quarter data ends on the latest fiscal year-end, basis must be "FY"
        # so normalized_fcf does not double-count that year alongside fcf_history[-1]
        data = {"timeseries": {"result": [
            ts("annualOperatingCashFlow", ("2022-12-31", 4 * B), ("2023-12-31", 8 * B)),
            ts("annualCapitalExpenditure", ("2022-12-31", -1 * B), ("2023-12-31", -2 * B)),
            ts("quarterlyOperatingCashFlow", ("2023-03-31", 2 * B), ("2023-06-30", 2 * B),
               ("2023-09-30", 2 * B), ("2023-12-31", 2 * B)),
            ts("quarterlyCapitalExpenditure", ("2023-03-31", -0.5 * B), ("2023-06-30", -0.5 * B),
               ("2023-09-30", -0.5 * B), ("2023-12-31", -0.5 * B)),
            ts("trailingOperatingCashFlow", ("2023-12-31", 8 * B)),
            ts("trailingCapitalExpenditure", ("2023-12-31", -2 * B)),
            ts("quarterlyOrdinarySharesNumber", ("2023-12-31", 1 * B)),
        ]}}
        r = parse_yahoo_timeseries(data)
        self.assertEqual((r["fcf_basis"], r["fcf_period_end"], r["free_cash_flow"]), ("FY", "2023-12-31", 6.0))

    def test_empty(self):
        self.assertIsNone(parse_yahoo_timeseries({"timeseries": {"result": []}}))


if __name__ == "__main__":
    unittest.main()

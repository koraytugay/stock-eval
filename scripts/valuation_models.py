"""
Valuation Models:
1. Standard Forward DCF (FCFF - Free Cash Flow to Firm)
2. Reverse DCF (Market Implied Growth Rate)
3. Historical FCF growth estimate
4. ETF look-through valuation
"""

import math
import datetime

REVERSE_DCF_LOW_G = -0.50
REVERSE_DCF_HIGH_G = 1.50


def _dcf_enterprise_value(fcf, growth_rate, terminal_growth, wacc, forecast_years):
    cur_fcf = fcf
    pv_cf = 0.0
    for i in range(1, forecast_years + 1):
        cur_fcf *= (1.0 + growth_rate)
        pv_cf += cur_fcf / ((1.0 + wacc) ** i)

    terminal_fcf = cur_fcf * (1.0 + terminal_growth)
    terminal_val = terminal_fcf / (wacc - terminal_growth)
    pv_terminal = terminal_val / ((1.0 + wacc) ** forecast_years)
    return pv_cf + pv_terminal


def compute_dcf(fcf, growth_rate=0.05, terminal_growth=0.025, wacc=0.08, net_debt=0.0, shares=1.0, forecast_years=5):
    """
    Standard multi-stage Free Cash Flow to Firm DCF.
    Returns None when the model does not apply (non-positive FCF or shares, WACC <= terminal growth).
    """
    if fcf is None or fcf <= 0 or shares is None or shares <= 0:
        return None
    if wacc <= terminal_growth:
        return None

    enterprise_value = _dcf_enterprise_value(fcf, growth_rate, terminal_growth, wacc, forecast_years)
    equity_value = enterprise_value - net_debt
    intrinsic_per_share = equity_value / shares

    return {
        "enterprise_value": round(enterprise_value, 3),
        "equity_value": round(equity_value, 3),
        "intrinsic_value": round(intrinsic_per_share, 2),
        "wacc": wacc,
        "growth_rate": growth_rate,
        "terminal_growth": terminal_growth
    }


def compute_reverse_dcf(market_price, fcf, shares, net_debt, wacc=0.08, terminal_growth=0.025, forecast_years=5):
    """
    Solves for the annual forecast-period growth rate (g) that equates DCF enterprise value to the
    market-implied enterprise value. Uses binary search; EV is monotonic in g for positive FCF.

    Returns {"growth": g or None, "status": "ok" | "above_range" | "below_range"}, or None if not applicable.
    """
    if market_price is None or market_price <= 0 or shares is None or shares <= 0:
        return None
    if fcf is None or fcf <= 0 or wacc <= terminal_growth:
        return None

    target_ev = market_price * shares + net_debt

    def ev(g):
        return _dcf_enterprise_value(fcf, g, terminal_growth, wacc, forecast_years)

    if target_ev <= ev(REVERSE_DCF_LOW_G):
        return {"growth": None, "status": "below_range"}
    if target_ev >= ev(REVERSE_DCF_HIGH_G):
        return {"growth": None, "status": "above_range"}

    low_g, high_g = REVERSE_DCF_LOW_G, REVERSE_DCF_HIGH_G
    tolerance = abs(target_ev) * 1e-6
    for _ in range(100):
        mid_g = (low_g + high_g) / 2.0
        model_ev = ev(mid_g)
        if abs(model_ev - target_ev) <= tolerance:
            break
        if model_ev < target_ev:
            low_g = mid_g
        else:
            high_g = mid_g

    return {"growth": round((low_g + high_g) / 2.0, 4), "status": "ok"}


def estimate_growth(fcf_history, default=0.04, floor=0.0, cap=0.15, min_years=3):
    """
    Estimates forecast growth from up to the last 6 annual FCF values as the median of pairwise log-growth
    rates (Theil-Sen), which ignores a single unusual year instead of letting it set the growth rate the way
    a point-to-point CAGR does.
    The result is clamped to [floor, cap]. Falls back to `default` when history is too short or any
    year has non-positive FCF (growth is not meaningful through a loss year).

    fcf_history: list of [period_end_iso, fcf] sorted ascending.
    Returns (growth_rate, source) where source is "historical" or "default".
    """
    points = (fcf_history or [])[-6:]
    if len(points) < 3 or any(v is None or v <= 0 for _, v in points):
        return default, "default"
    t0 = datetime.date.fromisoformat(points[0][0])
    xs = [(datetime.date.fromisoformat(d) - t0).days / 365.25 for d, _ in points]
    if xs[-1] < min_years - 0.1:
        return default, "default"
    ys = [math.log(v) for _, v in points]
    slopes = sorted((ys[j] - ys[i]) / (xs[j] - xs[i])
                    for i in range(len(xs)) for j in range(i + 1, len(xs)) if xs[j] > xs[i])
    mid = len(slopes) // 2
    slope = slopes[mid] if len(slopes) % 2 else (slopes[mid - 1] + slopes[mid]) / 2
    growth = math.exp(slope) - 1.0
    return round(min(max(growth, floor), cap), 4), "historical"


def normalized_fcf(latest_fcf, fcf_history, basis="FY", years=3):
    """
    Averages the latest FCF (TTM or FY) with the preceding fiscal years so one unusually strong or weak
    year (common for cyclicals) does not drive the whole valuation. years=1 disables normalization.
    """
    if latest_fcf is None:
        return None
    history = [v for _, v in (fcf_history or []) if v is not None]
    # With an FY basis the latest value is already the last history point
    prior = history[:-1] if basis == "FY" else history
    values = [latest_fcf] + prior[::-1][:max(years - 1, 0)]
    return round(sum(values) / len(values), 3)


def etf_look_through(holdings, stocks):
    """
    Aggregates constituent valuations by portfolio weight. For $1 invested, holding i contributes
    w_i * (intrinsic_i / price_i) of intrinsic value, so the ratio is currency-agnostic as long as each
    stock's intrinsic value is expressed in its own price currency.

    Only holdings with a valid valuation count toward coverage and the aggregate. A negative DCF value
    (debt exceeding enterprise value) counts as zero: shareholders cannot lose more than the share price.
    """
    total_weight = sum(h.get("weight", 0) for h in holdings)
    valued_weight = 0.0
    intrinsic_per_dollar = 0.0

    for h in holdings:
        w = h.get("weight", 0)
        stock = stocks.get(h.get("ticker")) or {}
        price = stock.get("market_price")
        intrinsic = (stock.get("valuation") or {}).get("intrinsic_dcf")
        if not price or price <= 0 or intrinsic is None:
            continue
        intrinsic_per_dollar += w * (max(intrinsic, 0.0) / price)
        valued_weight += w

    result = {
        "holdings_count": len(holdings),
        "covered_weight_pct": round(valued_weight / total_weight * 100, 1) if total_weight > 0 else 0.0,
        "intrinsic_per_dollar": None,
        "market_premium_pct": None
    }
    if valued_weight > 0:
        per_dollar = intrinsic_per_dollar / valued_weight
        result["intrinsic_per_dollar"] = round(per_dollar, 4)
        if per_dollar > 0:
            result["market_premium_pct"] = round((1.0 / per_dollar - 1.0) * 100.0, 2)
    return result

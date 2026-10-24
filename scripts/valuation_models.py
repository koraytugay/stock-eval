"""
Valuation Models:
1. Standard Forward DCF (FCFF - Free Cash Flow to Firm)
2. Reverse DCF (Market Implied Growth Rate)
"""

def compute_dcf(fcf, growth_rate=0.05, terminal_growth=0.025, wacc=0.08, net_debt=0.0, shares=1.0, forecast_years=5):
    """
    Standard multi-stage Free Cash Flow to Firm DCF.
    Returns:
        dict with enterprise_value, equity_value, intrinsic_per_share
    """
    if shares <= 0:
        return None
    if fcf is None:
        return None

    # Base projection
    cur_fcf = max(fcf, 0.0) # Handle non-positive gracefully
    pv_cf = 0.0
    for i in range(1, forecast_years + 1):
        cur_fcf *= (1.0 + growth_rate)
        pv_cf += cur_fcf / ((1.0 + wacc) ** i)
    
    # Terminal value
    terminal_fcf = cur_fcf * (1.0 + terminal_growth)
    if wacc <= terminal_growth:
        terminal_val = 0.0
    else:
        terminal_val = terminal_fcf / (wacc - terminal_growth)
    
    pv_terminal = terminal_val / ((1.0 + wacc) ** forecast_years)
    enterprise_value = pv_cf + pv_terminal
    equity_value = enterprise_value - net_debt
    intrinsic_per_share = equity_value / shares

    return {
        "enterprise_value": round(enterprise_value, 2),
        "equity_value": round(equity_value, 2),
        "intrinsic_value": round(intrinsic_per_share, 2),
        "wacc": wacc,
        "growth_rate": growth_rate,
        "terminal_growth": terminal_growth
    }


def compute_reverse_dcf(market_price, fcf, shares, net_debt, wacc=0.08, terminal_growth=0.025, forecast_years=5):
    """
    Solves for the annual 5-year growth rate (g) that equates DCF equity value to current market price.
    Uses binary search for numerical stability.
    """
    if market_price <= 0 or shares <= 0 or fcf is None or fcf <= 0:
        return None

    target_equity = market_price * shares
    target_ev = target_equity + net_debt

    # Binary search for growth rate g between -50% and +100%
    low_g, high_g = -0.50, 1.50
    best_g = None

    for _ in range(40):
        mid_g = (low_g + high_g) / 2.0
        cur_fcf = fcf
        pv_cf = 0.0
        for i in range(1, forecast_years + 1):
            cur_fcf *= (1.0 + mid_g)
            pv_cf += cur_fcf / ((1.0 + wacc) ** i)
        
        terminal_fcf = cur_fcf * (1.0 + terminal_growth)
        terminal_val = terminal_fcf / max(wacc - terminal_growth, 0.005)
        pv_terminal = terminal_val / ((1.0 + wacc) ** forecast_years)
        model_ev = pv_cf + pv_terminal

        if abs(model_ev - target_ev) < 1.0: # Close enough in millions
            best_g = mid_g
            break
        elif model_ev < target_ev:
            low_g = mid_g
        else:
            high_g = mid_g

    if best_g is None:
        best_g = (low_g + high_g) / 2.0

    return round(best_g, 4)

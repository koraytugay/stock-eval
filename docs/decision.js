// Pure decision logic for the ETF dashboard (no DOM access) so it can be unit tested with `node --test`.

const DECISION_CONFIG = {
  minHistoryRows: 60,        // fewer rows make a percentile meaningless
  minCoveragePct: 30,        // below this valued weight %, a look-through sample is too small for a BUY trigger
  buyPercentile: 20,         // premium at or below this historical percentile is a bargain
  accumulatePercentile: 65,  // above this the ETF is "extended"
  waitPercentile: 85,        // above this the ETF is too extended to chase even in a short-term uptrend
  smaWindow: 20,
  resetThresholdPct: 5,      // a one-day move this large in intrinsic value per fund unit is a fundamentals reset
  resetCooldownRows: 5,      // trading days after a reset during which a bargain percentile is not a BUY on its own
};

function median(values) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Latest date within the cool-down window ending at idx on which intrinsic value per fund unit (intrinsic per $1
// times the fund's price) moved more than resetThresholdPct in a day. Price moves largely cancel out of that
// product, so such a step comes from new filings or holdings entering or leaving the valuation, not the market:
// the premium jumps against a history that was measured on the old fundamentals.
function fundamentalsResetOn(rows, idx, cfg = DECISION_CONFIG) {
  if (!rows) return null;
  const unit = r => (r && typeof r[1] === "number" && typeof r[4] === "number" && r[1] > 0 && r[4] > 0) ? r[1] * r[4] : null;
  for (let i = idx; i > 0 && i > idx - cfg.resetCooldownRows; i--) {
    const cur = unit(rows[i]);
    const prev = unit(rows[i - 1]);
    if (cur !== null && prev !== null && Math.abs(cur / prev - 1) * 100 > cfg.resetThresholdPct) return rows[i][0];
  }
  return null;
}

function historyStats(rows, cfg = DECISION_CONFIG, currentPremium = undefined) {
  if (!rows || rows.length < cfg.minHistoryRows) return null;
  const premiums = rows.map(r => r[2]);
  const current = typeof currentPremium === "number" ? currentPremium : premiums[premiums.length - 1];
  const sorted = premiums.slice().sort((a, b) => a - b);
  const percentile = (premiums.filter(p => p <= current).length / premiums.length) * 100;
  const p20 = sorted[Math.max(0, Math.floor(sorted.length * 0.20) - 1)];

  // Short moving average of price, when price history is available
  const prices = rows.map(r => r[4]).filter(p => typeof p === "number");
  let sma20 = null;
  let priceTrendUp = false;
  if (prices.length >= 3) {
    const window = prices.slice(Math.max(0, prices.length - cfg.smaWindow));
    sma20 = window.reduce((a, b) => a + b, 0) / window.length;
    priceTrendUp = prices[prices.length - 1] > sma20;
  }

  // Latest day on which the set of holdings behind the look-through changed (rows carry a holdings hash)
  let holdingsChangedOn = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][5] && rows[i - 1][5] && rows[i][5] !== rows[i - 1][5]) holdingsChangedOn = rows[i][0];
  }

  return {
    holdingsChangedOn,
    fundamentalsResetOn: fundamentalsResetOn(rows, rows.length - 1, cfg),
    current,
    percentile,
    p20,
    min: Math.min(...premiums),
    max: Math.max(...premiums),
    median: median(premiums),
    sma20,
    priceTrendUp
  };
}

function pointInTimePercentile(rows, idx, cfg = DECISION_CONFIG) {
  if (!rows || !rows[idx] || typeof rows[idx][2] !== "number") return null;
  const prem = rows[idx][2];
  // Use causal history up to idx once the minimum warm-up window is reached; never look beyond minHistoryRows
  const end = Math.min(rows.length, Math.max(idx + 1, cfg.minHistoryRows));
  const windowPrems = [];
  for (let k = 0; k < end; k++) {
    if (typeof rows[k][2] === "number") windowPrems.push(rows[k][2]);
  }
  if (!windowPrems.length) return null;
  return (windowPrems.filter(p => p <= prem).length / windowPrems.length) * 100;
}

function chooseStance(percentile, intrinsicPerDollar, stats, coveragePct, cfg = DECISION_CONFIG) {
  const wait = { code: "WAIT", label: "Wait / Extended", cls: "stance-wait", icon: "\u23f8", rank: 3 };
  if (typeof percentile !== "number") return wait;

  const isBuy = percentile <= cfg.buyPercentile;
  const lowCoverage = typeof coveragePct === "number" && coveragePct < cfg.minCoveragePct;
  if (isBuy) {
    if (lowCoverage) {
      return { code: "ACCUMULATE", label: "Low Coverage / Accumulate", cls: "stance-accumulate", icon: "\u25c8", rank: 2,
               heldBy: "low coverage" };
    }
    if (stats && stats.fundamentalsResetOn) {
      return { code: "ACCUMULATE", label: "Fundamentals Reset / Accumulate", cls: "stance-accumulate", icon: "\u25c8", rank: 2,
               heldBy: "fundamentals reset" };
    }
    return { code: "BUY", label: "Strong Value / Buy", cls: "stance-buy", icon: "\u2713", rank: 1 };
  }
  if (percentile <= cfg.accumulatePercentile) {
    return { code: "ACCUMULATE", label: "Fair / Accumulate", cls: "stance-accumulate", icon: "\u25c8", rank: 2 };
  }
  // Moderately extended valuation (65th-85th percentile): ride an active uptrend rather than wait;
  // above waitPercentile, the valuation is too extended to chase regardless of short-term momentum
  if (percentile <= cfg.waitPercentile && stats && stats.priceTrendUp) {
    return { code: "ACCUMULATE", label: "Uptrend / Accumulate", cls: "stance-accumulate", icon: "\u25b2", rank: 2 };
  }
  return wait;
}

// Tag shown next to the buy-below price: in the zone, below the target but held back from BUY (and why), or the
// distance still to fall
function buyZoneTag(stance, distancePct) {
  if (stance && stance.code === "BUY") return { cls: "distance-in-zone", text: "In Buy Zone!" };
  if (typeof distancePct !== "number") return null;
  if (distancePct <= 0) {
    return { cls: "distance-low-cov", text: `Below target \u00b7 held: ${(stance && stance.heldBy) || "not confirmed"}` };
  }
  return { cls: "distance-above", text: `+${distancePct.toFixed(1)}% to target` };
}

// Splits cash into whole shares of the candidates. Cash and prices are in the same currency (every tracked fund
// trades in CAD). Each fund's weight comes from its own historical percentile (never cross-comparing raw intrinsic
// per $1 across funds, which is skewed by sector and style); "buy_and_accumulate" boosts BUY funds 2.5x.
function computeAllocation(candidates, cash, strategy) {
  if (!candidates || candidates.length === 0 || !cash || cash <= 0) {
    return { orders: [], totalInvested: 0, unusedCash: cash || 0 };
  }

  // Deduplicate candidates by ID to protect against duplicate purchase orders
  const seenIds = new Set();
  candidates = candidates.filter(c => !seenIds.has(c.id) && seenIds.add(c.id));

  const weights = candidates.map(c => {
    const base = Math.max(100.0 - (c.stats ? c.stats.percentile : 50), 1.0);
    return strategy === "buy_and_accumulate" && c.dec && c.dec.stance && c.dec.stance.code === "BUY" ? base * 2.5 : base;
  });
  const totWeight = weights.reduce((s, w) => s + w, 0) || 1;

  // Initial whole-share allocation
  const orders = candidates.map((c, i) => {
    const price = (c.dec && typeof c.dec.marketPrice === "number") ? c.dec.marketPrice : ((c.data && c.data.market_price) || 0);
    const shares = price > 0 ? Math.floor((cash * weights[i] / totWeight) / price) : 0;
    return { etf: c, price, shares, cost: shares * price, score: weights[i] };
  });

  // Remainder pass: spend what is left on the highest-scoring funds whose price still fits
  let remaining = cash - orders.reduce((s, o) => s + o.cost, 0);
  for (const o of orders.slice().sort((a, b) => b.score - a.score)) {
    if (o.price <= 0) continue;
    while (remaining >= o.price) {
      o.shares += 1;
      o.cost += o.price;
      remaining -= o.price;
    }
  }

  const totalInvested = orders.reduce((s, o) => s + o.cost, 0);
  return { orders, totalInvested, unusedCash: Math.max(0, cash - totalInvested) };
}

if (typeof module !== "undefined") {
  module.exports = { DECISION_CONFIG, median, historyStats, fundamentalsResetOn, pointInTimePercentile, chooseStance, buyZoneTag, computeAllocation };
}


// Pure decision logic for the ETF dashboard (no DOM access) so it can be unit tested with `node --test`.

const DECISION_CONFIG = {
  minHistoryRows: 60,        // fewer rows make a percentile meaningless
  buyPercentile: 20,         // premium at or below this historical percentile is a bargain
  deepBuyPercentile: 25,     // ... or this one when the intrinsic discount is deep
  deepIntrinsicPerDollar: 1.25,
  accumulatePercentile: 65,  // above this the ETF is "extended"
  smaWindow: 20,
};

function median(values) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function historyStats(rows, cfg = DECISION_CONFIG, currentPremium = undefined) {
  if (!rows || rows.length < cfg.minHistoryRows) return null;
  const premiums = rows.map(r => r[2]);
  const current = typeof currentPremium === "number" ? currentPremium : premiums[premiums.length - 1];
  const sorted = premiums.slice().sort((a, b) => a - b);
  const percentile = (premiums.filter(p => p <= current).length / premiums.length) * 100;
  const p20 = sorted[Math.max(0, Math.floor(sorted.length * 0.20) - 1)];
  const p25 = sorted[Math.max(0, Math.floor(sorted.length * 0.25) - 1)];

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
    current,
    percentile,
    p20,
    p25,
    min: Math.min(...premiums),
    max: Math.max(...premiums),
    median: median(premiums),
    sma20,
    priceTrendUp
  };
}

function chooseStance(percentile, intrinsicPerDollar, stats, coveragePct, cfg = DECISION_CONFIG) {
  const wait = { code: "WAIT", label: "Wait / Extended", cls: "stance-wait", icon: "\u23f8", rank: 3 };
  if (typeof percentile !== "number") return wait;

  const deepDiscount = typeof intrinsicPerDollar === "number" && intrinsicPerDollar >= cfg.deepIntrinsicPerDollar;
  const isBuy = percentile <= cfg.buyPercentile || (deepDiscount && percentile <= cfg.deepBuyPercentile);
  if (isBuy) {
    return { code: "BUY", label: "Strong Value / Buy", cls: "stance-buy", icon: "\u2713", rank: 1 };
  }
  if (percentile <= cfg.accumulatePercentile) {
    return { code: "ACCUMULATE", label: "Fair / Accumulate", cls: "stance-accumulate", icon: "\u25c8", rank: 2 };
  }
  // Extended valuation: ride an active uptrend (above its moving average) rather than wait
  if (stats && stats.priceTrendUp) {
    return { code: "ACCUMULATE", label: "Uptrend / Accumulate", cls: "stance-accumulate", icon: "\u25b2", rank: 2 };
  }
  return wait;
}

function computeAllocation(candidates, cash, strategy, fxRates = {}) {
  if (!candidates || candidates.length === 0 || !cash || cash <= 0) {
    return {
      orders: [],
      totalInvestedCad: 0,
      unusedCashCad: cash || 0,
      weightedFcf: null,
      weightedPrem: null
    };
  }

  // Deduplicate candidates by ID to protect against duplicate purchase orders
  const seenIds = new Set();
  const uniqueCandidates = [];
  for (const c of candidates) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      uniqueCandidates.push(c);
    }
  }
  candidates = uniqueCandidates;

  // 1. Compute candidate scores / target weights
  let weights = [];
  if (strategy === "buy_and_core" && candidates.some(c => c.id === "TSE:XEQT")) {
    const coreShare = 0.50;
    const otherCount = Math.max(candidates.length - 1, 1);
    const otherShareEach = (1.0 - coreShare) / otherCount;
    weights = candidates.map(c => c.id === "TSE:XEQT" ? coreShare : otherShareEach);
  } else if (strategy === "buy_and_accumulate") {
    weights = candidates.map(c => {
      const base = (100.0 - (c.stats ? c.stats.percentile : 50)) * Math.max(c.data.intrinsic_per_dollar || 1.0, 0.4);
      return (c.dec && c.dec.stance && c.dec.stance.code === "BUY") ? base * 2.5 : base;
    });
  } else {
    weights = candidates.map(c => {
      const pctile = c.stats ? c.stats.percentile : 50;
      return (100.0 - pctile) * Math.max(c.data.intrinsic_per_dollar || 1.0, 0.5);
    });
  }
  const totWeight = weights.reduce((s, w) => s + w, 0) || 1;

  // 2. Initial whole share allocation converted to CAD
  let orders = candidates.map((c, i) => {
    const w = weights[i] / totWeight;
    const targetDollars = cash * w;
    const ccy = (c.dec && c.dec.currency) || (c.data && c.data.currency) || "CAD";
    const fxRate = ccy === "CAD" ? 1.0 : (fxRates[`${ccy}CAD`] || 1.38);
    const priceNative = (c.dec && typeof c.dec.marketPrice === "number") ? c.dec.marketPrice : ((c.data && c.data.market_price) || 0);
    const priceCad = priceNative * fxRate;
    const shares = priceCad > 0 ? Math.floor(targetDollars / priceCad) : 0;
    const costNative = shares * priceNative;
    const costCad = shares * priceCad;

    return {
      etf: c,
      currency: ccy,
      fxRate,
      priceNative,
      priceCad,
      shares,
      costNative,
      costCad,
      targetDollars,
      score: weights[i]
    };
  });

  // 3. Remainder pass: allocate unspent dollars to candidate with highest value score if price fits
  let spentCad = orders.reduce((s, o) => s + o.costCad, 0);
  let remCad = cash - spentCad;
  const sortedOrdersByScore = orders.slice().sort((a, b) => b.score - a.score);

  for (const o of sortedOrdersByScore) {
    if (o.priceCad <= 0) continue;
    while (remCad >= o.priceCad) {
      o.shares += 1;
      o.costCad += o.priceCad;
      o.costNative += o.priceNative;
      remCad -= o.priceCad;
      spentCad += o.priceCad;
    }
  }

  const totalInvestedCad = spentCad;
  const unusedCashCad = Math.max(0, cash - totalInvestedCad);

  // 4. Compute weighted metrics of this purchase
  let sumFcf = 0;
  let sumPrem = 0;
  let costWithStats = 0;

  for (const o of orders) {
    if (o.costCad > 0) {
      if (o.etf.dec && typeof o.etf.dec.fcfYield === "number") {
        sumFcf += o.costCad * o.etf.dec.fcfYield;
      }
      if (o.etf.data && typeof o.etf.data.market_premium_pct === "number") {
        sumPrem += o.costCad * o.etf.data.market_premium_pct;
        costWithStats += o.costCad;
      }
    }
  }

  const weightedFcf = totalInvestedCad > 0 ? (sumFcf / totalInvestedCad) : null;
  const weightedPrem = costWithStats > 0 ? (sumPrem / costWithStats) : null;

  return {
    orders,
    totalInvestedCad,
    unusedCashCad,
    weightedFcf,
    weightedPrem
  };
}

if (typeof module !== "undefined") {
  module.exports = { DECISION_CONFIG, median, historyStats, chooseStance, computeAllocation };
}


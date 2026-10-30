// Pure decision logic for the ETF dashboard (no DOM access) so it can be unit tested with `node --test`.

const DECISION_CONFIG = {
  minHistoryRows: 60,        // fewer rows make a percentile meaningless
  buyPercentile: 20,         // premium at or below this historical percentile is a bargain
  deepBuyPercentile: 25,     // ... or this one when the intrinsic discount is deep
  deepIntrinsicPerDollar: 1.25,
  accumulatePercentile: 65,  // above this the ETF is "extended"
  minCoveragePct: 25,        // below this share of the fund valued, a Buy is demoted to Accumulate
  smaWindow: 20,
};

function median(values) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function historyStats(rows, cfg = DECISION_CONFIG) {
  if (!rows || rows.length < cfg.minHistoryRows) return null;
  const premiums = rows.map(r => r[2]);
  const current = premiums[premiums.length - 1];
  const sorted = premiums.slice().sort((a, b) => a - b);
  const percentile = (premiums.filter(p => p <= current).length / premiums.length) * 100;
  const p20 = sorted[Math.floor(sorted.length * 0.20)];

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
    // A signal built on a small slice of the fund is not trustworthy enough for a full Buy
    if (typeof coveragePct === "number" && coveragePct < cfg.minCoveragePct) {
      return { code: "ACCUMULATE", label: "Low coverage / Accumulate", cls: "stance-accumulate", icon: "\u25c8",
               rank: 2, lowCoverage: true };
    }
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

if (typeof module !== "undefined") {
  module.exports = { DECISION_CONFIG, median, historyStats, chooseStance };
}

const test = require("node:test");
const assert = require("node:assert");
const { historyStats, pointInTimePercentile, chooseStance, computeAllocation, DECISION_CONFIG } = require("../docs/decision.js");

const rows = (premiums, prices) => premiums.map((p, i) => ["d" + i, 1, p, 50, prices ? prices[i] : 10]);
const ramp = n => Array.from({ length: n }, (_, i) => i);  // premiums 0..n-1, current is the highest

test("needs enough history", () => {
  assert.strictEqual(historyStats(rows(ramp(DECISION_CONFIG.minHistoryRows - 1))), null);
  assert.ok(historyStats(rows(ramp(DECISION_CONFIG.minHistoryRows))));
});

test("percentile of the latest premium", () => {
  const stats = historyStats(rows([...ramp(99).reverse(), 0].map(Number)));  // latest is the lowest
  assert.ok(stats.percentile <= 2);
  const upStats = historyStats(rows(ramp(100)));
  assert.strictEqual(upStats.percentile, 100);
  assert.strictEqual(upStats.p20, 19);
  assert.strictEqual(upStats.p25, 24);
  // A premium equal to p20 must evaluate to exactly the 20th percentile (not 21st)
  assert.strictEqual(historyStats(rows(ramp(100)), DECISION_CONFIG, upStats.p20).percentile, 20);
  assert.strictEqual(historyStats(rows(ramp(100)), DECISION_CONFIG, upStats.p25).percentile, 25);

  // Evaluates explicit currentPremium when passed
  const customStats = historyStats(rows(ramp(100)), DECISION_CONFIG, 15);
  assert.strictEqual(customStats.percentile, 16);
});

test("uptrend flag compares price to its moving average", () => {
  const up = historyStats(rows(ramp(100), ramp(100).map(i => 10 + i)));
  const down = historyStats(rows(ramp(100), ramp(100).map(i => 200 - i)));
  assert.strictEqual(up.priceTrendUp, true);
  assert.strictEqual(down.priceTrendUp, false);
});

test("stances by percentile are uniform across intrinsic_per_dollar", () => {
  assert.strictEqual(chooseStance(20, 0.8, null, 50).code, "BUY");
  assert.strictEqual(chooseStance(23, 0.8, null, 50).code, "ACCUMULATE");   // 21-65: fair
  assert.strictEqual(chooseStance(23, 1.5, null, 50).code, "ACCUMULATE");   // no cross-ETF style bias at 23rd pctile
  assert.strictEqual(chooseStance(50, 0.8, null, 50).label, "Fair / Accumulate");
  assert.strictEqual(chooseStance(90, 0.8, { priceTrendUp: false }, 50).code, "WAIT");
  assert.strictEqual(chooseStance(90, 0.8, { priceTrendUp: true }, 50).label, "Uptrend / Accumulate");
  assert.strictEqual(chooseStance(null, 0.8, null, 50).code, "WAIT");
});

test("pointInTimePercentile does not leak future rows after warm-up", () => {
  // First 80 days have premiums 100..179; days 80..99 crash to 0..19.
  // On day 70 (premium 170), future crash days 80..99 must not affect its point-in-time percentile.
  const prems = [...Array.from({ length: 80 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => i)];
  const rs = rows(prems);
  assert.strictEqual(pointInTimePercentile(rs, 60), 100);
  // At day 79, 100 is the minimum of days 0..79 (1/80 = 1.25%), even though days 80..99 are lower
  const rsWithLowAt79 = rows([...Array.from({ length: 79 }, (_, i) => 101 + i), 100, ...Array.from({ length: 20 }, (_, i) => i)]);
  assert.strictEqual(pointInTimePercentile(rsWithLowAt79, 79), (1 / 80) * 100);
});

test("buy stance triggers on historical percentile bargain and respects minimum coverage", () => {
  assert.strictEqual(chooseStance(5, 1.5, null, 25).code, "BUY");
  assert.strictEqual(chooseStance(5, 1.5, null, null).code, "BUY");
  // Below minCoveragePct (10%), a bargain percentile is capped at ACCUMULATE so tiny samples do not trigger BUY
  const lowCov = chooseStance(5, 1.5, null, 4.2);
  assert.strictEqual(lowCov.code, "ACCUMULATE");
  assert.strictEqual(lowCov.label, "Low Coverage / Accumulate");
});

test("detects the latest holdings change", () => {
  const rs = rows(ramp(100));
  rs.forEach((r, i) => { r.push(i < 40 ? "aaa" : i < 80 ? "bbb" : "ccc"); });
  assert.strictEqual(historyStats(rs).holdingsChangedOn, "d80");
  assert.strictEqual(historyStats(rows(ramp(100))).holdingsChangedOn, null);   // rows without hashes
});

test("computeAllocation with empty or zero cash", () => {
  assert.strictEqual(computeAllocation([], 1000, "buy_zone").orders.length, 0);
  assert.strictEqual(computeAllocation([{ id: "A" }], 0, "buy_zone").orders.length, 0);
});

test("computeAllocation handles multi-currency (USD and CAD) accurately", () => {
  const candidates = [
    {
      id: "TSE:XEQT",
      data: { currency: "CAD", intrinsic_per_dollar: 1.0, market_premium_pct: 0 },
      dec: { currency: "CAD", marketPrice: 40.0, stance: { code: "BUY" }, fcfYield: 3.5 },
      stats: { percentile: 10 }
    },
    {
      id: "VXUS",
      data: { currency: "USD", intrinsic_per_dollar: 1.0, market_premium_pct: 0 },
      dec: { currency: "USD", marketPrice: 50.0, stance: { code: "BUY" }, fcfYield: 4.0 },
      stats: { percentile: 10 }
    }
  ];

  // USDCAD rate = 1.40 -> VXUS price in CAD = $50.0 * 1.40 = $70.0 CAD
  const fxRates = { USDCAD: 1.40 };
  const alloc = computeAllocation(candidates, 1000, "buy_zone", fxRates);

  assert.strictEqual(alloc.orders.length, 2);
  const xeqt = alloc.orders.find(o => o.etf.id === "TSE:XEQT");
  const vxus = alloc.orders.find(o => o.etf.id === "VXUS");

  assert.strictEqual(xeqt.priceCad, 40.0);
  assert.strictEqual(vxus.priceNative, 50.0);
  assert.strictEqual(vxus.priceCad, 70.0);

  // Check that total invested + unused cash equals exactly 1000 CAD
  assert.strictEqual(alloc.totalInvestedCad + alloc.unusedCashCad, 1000);
  assert.ok(vxus.shares > 0);
  assert.strictEqual(vxus.costCad, vxus.shares * 70.0);
  assert.strictEqual(vxus.costNative, vxus.shares * 50.0);
});

test("computeAllocation deduplicates candidates to prevent duplicate orders in buy_and_core", () => {
  const fakeXeqt = {
    id: "TSE:XEQT",
    data: { currency: "CAD", intrinsic_per_dollar: 1.0, market_premium_pct: 0 },
    dec: { currency: "CAD", marketPrice: 40.0, stance: { code: "BUY" }, fcfYield: 3.5 },
    stats: { percentile: 10 }
  };
  const fakeOther = {
    id: "TSE:CAEM",
    data: { currency: "CAD", intrinsic_per_dollar: 1.0, market_premium_pct: 0 },
    dec: { currency: "CAD", marketPrice: 20.0, stance: { code: "BUY" }, fcfYield: 4.0 },
    stats: { percentile: 5 }
  };

  // Even if caller passed XEQT twice (as core and as buy zone fund):
  const alloc = computeAllocation([fakeXeqt, fakeXeqt, fakeOther], 1000, "buy_and_core");
  assert.strictEqual(alloc.orders.length, 2);
  const ids = alloc.orders.map(o => o.etf.id);
  assert.deepStrictEqual(ids, ["TSE:XEQT", "TSE:CAEM"]);

  // If one candidate lacks fcfYield, weightedFcf is weighted only across candidates with numeric fcfYield
  const noFcfOther = { ...fakeOther, dec: { ...fakeOther.dec, fcfYield: null } };
  const allocMissingFcf = computeAllocation([fakeXeqt, noFcfOther], 1000, "buy_and_core");
  assert.strictEqual(allocMissingFcf.weightedFcf, 3.5);
});

test("computeAllocation is style-neutral across intrinsic_per_dollar and skips foreign orders without FX", () => {
  const growthFund = {
    id: "TSE:CAUS",
    data: { currency: "CAD", intrinsic_per_dollar: 0.4, market_premium_pct: 150 },
    dec: { currency: "CAD", marketPrice: 25.0, stance: { code: "BUY" }, fcfYield: 2.0 },
    stats: { percentile: 10 }
  };
  const valueFund = {
    id: "TSE:CASV",
    data: { currency: "CAD", intrinsic_per_dollar: 2.2, market_premium_pct: -55 },
    dec: { currency: "CAD", marketPrice: 25.0, stance: { code: "BUY" }, fcfYield: 9.0 },
    stats: { percentile: 10 }
  };
  const alloc = computeAllocation([growthFund, valueFund], 1000, "buy_zone");
  assert.strictEqual(alloc.orders[0].targetDollars, 500);
  assert.strictEqual(alloc.orders[1].targetDollars, 500);

  // Without USDCAD in fxRates, a USD candidate must not guess 1.38 and size shares
  const usdFund = {
    id: "VXUS",
    data: { currency: "USD", intrinsic_per_dollar: 1.0, market_premium_pct: 0 },
    dec: { currency: "USD", marketPrice: 50.0, stance: { code: "BUY" }, fcfYield: 4.0 },
    stats: { percentile: 10 }
  };
  const noFxAlloc = computeAllocation([usdFund], 1000, "buy_zone", {});
  assert.strictEqual(noFxAlloc.orders[0].shares, 0);
  assert.strictEqual(noFxAlloc.totalInvestedCad, 0);
});

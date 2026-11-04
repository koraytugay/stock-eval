const test = require("node:test");
const assert = require("node:assert");
const { historyStats, fundamentalsResetOn, pointInTimePercentile, chooseStance, buyZoneTag, computeAllocation, DECISION_CONFIG } = require("../docs/decision.js");

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
  // A premium equal to p20 must evaluate to exactly the 20th percentile (not 21st)
  assert.strictEqual(historyStats(rows(ramp(100)), DECISION_CONFIG, upStats.p20).percentile, 20);

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
  assert.strictEqual(chooseStance(75, 0.8, { priceTrendUp: false }, 50).code, "WAIT");
  assert.strictEqual(chooseStance(75, 0.8, { priceTrendUp: true }, 50).label, "Uptrend / Accumulate");
  // Above waitPercentile (85), WAIT is enforced even when price is above its 20-day moving average
  assert.strictEqual(chooseStance(90, 0.8, { priceTrendUp: true }, 50).code, "WAIT");
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
  assert.strictEqual(chooseStance(5, 1.5, null, 35).code, "BUY");
  assert.strictEqual(chooseStance(5, 1.5, null, 30).code, "BUY");
  assert.strictEqual(chooseStance(5, 1.5, null, null).code, "BUY");
  // Below minCoveragePct (30%), a bargain percentile is capped at ACCUMULATE so small samples do not trigger BUY
  assert.strictEqual(chooseStance(5, 1.5, null, 25).code, "ACCUMULATE");
  const lowCov = chooseStance(5, 1.5, null, 14.0);
  assert.strictEqual(lowCov.code, "ACCUMULATE");
  assert.strictEqual(lowCov.label, "Low Coverage / Accumulate");
});

test("detects the latest holdings change", () => {
  const rs = rows(ramp(100));
  rs.forEach((r, i) => { r.push(i < 40 ? "aaa" : i < 80 ? "bbb" : "ccc"); });
  assert.strictEqual(historyStats(rs).holdingsChangedOn, "d80");
  assert.strictEqual(historyStats(rows(ramp(100))).holdingsChangedOn, null);   // rows without hashes
});

test("flags a fundamentals reset when intrinsic value per unit steps but price does not", () => {
  const rs = rows(ramp(100));
  rs[97][1] = 1.2;  // intrinsic per $1 jumps 20% at a flat price
  for (let i = 98; i < 100; i++) rs[i][1] = 1.2;
  assert.strictEqual(historyStats(rs).fundamentalsResetOn, "d97");
  assert.strictEqual(fundamentalsResetOn(rs, 96), null);
  // Outside the cool-down window the reset no longer counts
  assert.strictEqual(fundamentalsResetOn(rs, 97 + DECISION_CONFIG.resetCooldownRows), null);
  // A market move changes intrinsic per $1 and price in opposite directions and is not a reset
  const mkt = rows(ramp(100));
  mkt[99][1] = 1 / 1.1; mkt[99][4] = 11;
  assert.strictEqual(historyStats(mkt).fundamentalsResetOn, null);
});

test("a bargain percentile right after a fundamentals reset is capped at ACCUMULATE", () => {
  const reset = chooseStance(5, 1.5, { fundamentalsResetOn: "d97" }, 50);
  assert.strictEqual(reset.code, "ACCUMULATE");
  assert.strictEqual(reset.label, "Fundamentals Reset / Accumulate");
  assert.strictEqual(chooseStance(5, 1.5, { fundamentalsResetOn: null }, 50).code, "BUY");
});

test("buy-zone tag says why a fund below its target is not a BUY", () => {
  assert.strictEqual(buyZoneTag(chooseStance(5, 1, null, 50), -3).text, "In Buy Zone!");
  assert.strictEqual(buyZoneTag(chooseStance(5, 1, null, 14), -7.5).text, "Below target \u00b7 held: low coverage");
  assert.strictEqual(buyZoneTag(chooseStance(5, 1, { fundamentalsResetOn: "d1" }, 50), -2).text,
                     "Below target \u00b7 held: fundamentals reset");
  assert.strictEqual(buyZoneTag(chooseStance(50, 1, null, 50), 4.25).text, "+4.3% to target");
  assert.strictEqual(buyZoneTag(chooseStance(50, 1, null, 50), null), null);
});

const fund = (id, price, percentile, code = "BUY", intrinsicPerDollar = 1.0) => ({
  id,
  data: { currency: "CAD", intrinsic_per_dollar: intrinsicPerDollar },
  dec: { marketPrice: price, stance: { code } },
  stats: { percentile }
});

test("computeAllocation with empty or zero cash", () => {
  assert.strictEqual(computeAllocation([], 1000, "buy_zone").orders.length, 0);
  assert.strictEqual(computeAllocation([{ id: "A" }], 0, "buy_zone").orders.length, 0);
});

test("computeAllocation buys whole shares and accounts for every dollar", () => {
  const alloc = computeAllocation([fund("TSE:ZLU", 52.3, 12), fund("TSE:XEC", 31.7, 5)], 1000, "buy_zone");
  assert.strictEqual(alloc.orders.length, 2);
  for (const o of alloc.orders) {
    assert.ok(Number.isInteger(o.shares));
    assert.strictEqual(o.cost, o.shares * o.price);
  }
  assert.ok(Math.abs(alloc.totalInvested + alloc.unusedCash - 1000) < 1e-9);
  // The remainder pass leaves less than the cheapest share unspent
  assert.ok(alloc.unusedCash < 31.7);
});

test("computeAllocation deduplicates candidates to prevent duplicate orders", () => {
  const xeqt = fund("TSE:XEQT", 40, 10);
  const alloc = computeAllocation([xeqt, xeqt, fund("TSE:ZLI", 20, 5)], 1000, "buy_zone");
  assert.deepStrictEqual(alloc.orders.map(o => o.etf.id), ["TSE:XEQT", "TSE:ZLI"]);
});

test("computeAllocation is style-neutral across intrinsic_per_dollar", () => {
  const alloc = computeAllocation([fund("TSE:XUU", 25, 10, "BUY", 0.4), fund("TSE:XEF", 25, 10, "BUY", 2.2)], 1000, "buy_zone");
  assert.strictEqual(alloc.orders[0].shares, alloc.orders[1].shares);
});

test("buy_and_accumulate weights BUY funds 2.5x over ACCUMULATE at the same percentile", () => {
  const alloc = computeAllocation([fund("TSE:ZLU", 10, 50, "BUY"), fund("TSE:XEQT", 10, 50, "ACCUMULATE")],
                                  350, "buy_and_accumulate");
  assert.strictEqual(alloc.orders[0].score, alloc.orders[1].score * 2.5);
  assert.strictEqual(alloc.orders[0].shares, 25);
  assert.strictEqual(alloc.orders[1].shares, 10);
});

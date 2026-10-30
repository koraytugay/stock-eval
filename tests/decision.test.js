const test = require("node:test");
const assert = require("node:assert");
const { historyStats, chooseStance, DECISION_CONFIG } = require("../docs/decision.js");

const rows = (premiums, prices) => premiums.map((p, i) => ["d" + i, 1, p, 50, prices ? prices[i] : 10]);
const ramp = n => Array.from({ length: n }, (_, i) => i);  // premiums 0..n-1, current is the highest

test("needs enough history", () => {
  assert.strictEqual(historyStats(rows(ramp(DECISION_CONFIG.minHistoryRows - 1))), null);
  assert.ok(historyStats(rows(ramp(DECISION_CONFIG.minHistoryRows))));
});

test("percentile of the latest premium", () => {
  const stats = historyStats(rows([...ramp(99).reverse(), 0].map(Number)));  // latest is the lowest
  assert.ok(stats.percentile <= 2);
  assert.strictEqual(historyStats(rows(ramp(100))).percentile, 100);
});

test("uptrend flag compares price to its moving average", () => {
  const up = historyStats(rows(ramp(100), ramp(100).map(i => 10 + i)));
  const down = historyStats(rows(ramp(100), ramp(100).map(i => 200 - i)));
  assert.strictEqual(up.priceTrendUp, true);
  assert.strictEqual(down.priceTrendUp, false);
});

test("stances by percentile", () => {
  assert.strictEqual(chooseStance(10, 0.8, null, 50).code, "BUY");
  assert.strictEqual(chooseStance(23, 0.8, null, 50).code, "ACCUMULATE");   // 21-65: fair
  assert.strictEqual(chooseStance(23, 1.3, null, 50).code, "BUY");          // deep discount widens to 25
  assert.strictEqual(chooseStance(50, 0.8, null, 50).label, "Fair / Accumulate");
  assert.strictEqual(chooseStance(90, 0.8, { priceTrendUp: false }, 50).code, "WAIT");
  assert.strictEqual(chooseStance(90, 0.8, { priceTrendUp: true }, 50).label, "Uptrend / Accumulate");
  assert.strictEqual(chooseStance(null, 0.8, null, 50).code, "WAIT");
});

test("low coverage demotes Buy but not other stances", () => {
  const s = chooseStance(5, 1.5, null, 4.2);
  assert.strictEqual(s.code, "ACCUMULATE");
  assert.strictEqual(s.lowCoverage, true);
  assert.strictEqual(chooseStance(5, 1.5, null, null).code, "BUY");   // unknown coverage is not penalised
  assert.strictEqual(chooseStance(5, 1.5, null, 25).code, "BUY");
});

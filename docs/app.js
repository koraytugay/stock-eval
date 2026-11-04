// StockEval - ETF look-through valuation and buy signals

let currentSnapshot = null;
let etfHistory = null;

// The dashboard lives in docs/ and reads data/ from the repo root; "data/" is kept as a fallback for other layouts.
const DATA_ROOTS = ["../data/", "data/"];
let dataRoot = null;

document.addEventListener("DOMContentLoaded", async () => {
  setupAllocator();
  etfHistory = await fetchData("etf_history.json").catch(() => null);
  await loadSnapshot();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawEtfCharts, 150);
  });
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function fmtNum(n, digits = 2) {
  return typeof n === "number" && isFinite(n) ? n.toFixed(digits) : "-";
}

function fmtPct(n, digits = 1) {
  return typeof n === "number" && isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(digits)}%` : "N/A";
}

async function fetchData(path) {
  const roots = dataRoot ? [dataRoot] : DATA_ROOTS;
  for (const root of roots) {
    const res = await fetch(root + path).catch(() => null);
    if (res && res.ok) {
      dataRoot = root;
      return res.json();
    }
  }
  throw new Error(`Could not load ${path}`);
}

async function loadSnapshot() {
  try {
    currentSnapshot = await fetchData("latest.json");
    const badge = document.getElementById("last-updated");
    badge.textContent = `Snapshot: ${currentSnapshot.date}`;
    const fr = currentSnapshot.freshness;
    if (fr && fr.median_period_end) {
      badge.textContent += ` · fundamentals as of ${fr.median_period_end} (median)`;
      const oldShare = fr.valued ? fr.older_count / fr.valued : 0;
      badge.title = `Oldest fundamentals: ${fr.oldest_period_end}. ${fr.older_count} of ${fr.valued} valued stocks ` +
        `describe a period more than ${fr.older_than_days} days ago; ${fr.sec_fallback_count} use Yahoo data instead of SEC.`;
      badge.style.color = oldShare > 0.25 ? "#b45309" : "";
    }
    renderEtfs();
    renderAllocator();
  } catch (err) {
    console.error("Failed to load snapshot:", err);
    document.getElementById("last-updated").textContent = "Error loading snapshot";
    document.querySelector("#etf-summary-table tbody").innerHTML =
      `<tr><td colspan="7" class="loading">Could not load snapshot data.</td></tr>`;
  }
}

function etfHistoryRows(etfId) {
  return ((etfHistory && etfHistory.etfs && etfHistory.etfs[etfId]) || []).filter(r => typeof r[2] === "number");
}

function computeEtfDecision(data, stats) {
  const premium = data.market_premium_pct;
  const marketPrice = data.market_price;
  const percentile = stats ? stats.percentile : null;

  // Target premium threshold for a bargain entry (20th percentile of the ETF's own history)
  const targetPremium = stats ? stats.p20 : null;

  let buyBelowPrice = null;
  let distancePct = null;
  if (typeof marketPrice === "number" && typeof premium === "number" && typeof targetPremium === "number") {
    const intrinsicPrice = marketPrice / (1.0 + premium / 100.0);
    buyBelowPrice = intrinsicPrice * (1.0 + targetPremium / 100.0);
    distancePct = ((marketPrice - buyBelowPrice) / buyBelowPrice) * 100.0;
  }

  return {
    stance: chooseStance(percentile, data.intrinsic_per_dollar, stats, data.covered_weight_pct),
    buyBelowPrice,
    distancePct,
    targetPremium,
    marketPrice,
    currency: data.currency || "CAD"
  };
}

// Every fund with its history stats and decision, buy signals first, then by cheapest percentile
function etfRows() {
  if (!currentSnapshot || !currentSnapshot.etfs) return [];
  return Object.entries(currentSnapshot.etfs).map(([id, data]) => {
    const stats = historyStats(etfHistoryRows(id), DECISION_CONFIG, data.market_premium_pct);
    return { id, data, stats, dec: computeEtfDecision(data, stats) };
  }).sort((a, b) => {
    if (a.dec.stance.rank !== b.dec.stance.rank) return a.dec.stance.rank - b.dec.stance.rank;
    return (a.stats ? a.stats.percentile : 999) - (b.stats ? b.stats.percentile : 999);
  });
}

function renderEtfs() {
  const list = etfRows();
  document.getElementById("etf-backfill-date").textContent = (etfHistory && etfHistory.backfilled_until) || "-";

  const buys = list.filter(e => e.dec.stance.code === "BUY").map(e => e.id.replace("TSE:", ""));
  document.getElementById("buy-summary").innerHTML = buys.length
    ? `<strong>Buy signal today:</strong> ${escapeHtml(buys.join(", "))}`
    : "<strong>No buy signals today.</strong>";

  renderEtfSummary(list);
  renderEtfCards(list);
}

function renderEtfSummary(list) {
  const tbody = document.querySelector("#etf-summary-table tbody");
  tbody.innerHTML = list.map(({ id, data, stats, dec }) => {
    const premium = data.market_premium_pct;
    const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";

    const priceHtml = dec.marketPrice !== null && dec.marketPrice !== undefined
      ? `<strong>$${fmtNum(dec.marketPrice, 2)}</strong> <span class="muted">${escapeHtml(dec.currency)}</span>`
      : "-";

    let buyBelowHtml = "-";
    if (dec.buyBelowPrice !== null) {
      const tag = buyZoneTag(dec.stance, dec.distancePct);
      buyBelowHtml = `
        <strong>&le; $${fmtNum(dec.buyBelowPrice, 2)}</strong>
        ${tag ? `<div><span class="distance-tag ${tag.cls}">${escapeHtml(tag.text)}</span></div>` : ""}
      `;
    } else if (dec.targetPremium !== null) {
      buyBelowHtml = `Prem &le; ${fmtPct(dec.targetPremium)}`;
    }

    const safeId = id.replace(/[^a-zA-Z0-9]/g, "_");
    return `
      <tr class="clickable-row" data-etf="${safeId}" style="cursor: pointer;" title="Click to inspect ${escapeHtml(id)} chart and metrics">
        <td>
          <div style="display:flex; align-items:center; gap:6px;">
            <strong>${escapeHtml(id)}</strong>
            <span class="badge" style="font-size:0.68rem; padding:1px 5px;" title="${escapeHtml(unvaluedTitle(data))}">${fmtNum(data.covered_weight_pct, 1)}% Valued</span>
          </div>
          <span class="status-note">${escapeHtml(data.name || "")}</span>
        </td>
        <td><span class="stance-badge ${dec.stance.cls}"><span aria-hidden="true">${dec.stance.icon}</span> ${dec.stance.label}</span></td>
        <td>${priceHtml}</td>
        <td>${buyBelowHtml}</td>
        <td class="${premiumClass}"><strong>${fmtPct(premium)}</strong></td>
        <td>${stats ? `${fmtPct(stats.min)} to ${fmtPct(stats.max)}` : "-"}</td>
        <td><strong>${stats ? `${Math.round(stats.percentile)}th` : "-"}</strong></td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("tr[data-etf]").forEach(row => {
    row.addEventListener("click", () => {
      const targetCard = document.getElementById(`card-${row.dataset.etf}`);
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
        targetCard.classList.add("card-highlight");
        setTimeout(() => targetCard.classList.remove("card-highlight"), 1800);
      }
    });
  });
}

function computeHistoricalZoneWindows(rows) {
  if (!rows || rows.length < 5) return { buy: [], wait: [] };
  const premiums = rows.map(r => r[2]).filter(p => typeof p === "number");
  if (!premiums.length) return { buy: [], wait: [] };
  const n = premiums.length;

  // Precompute 20-day Simple Moving Average for prices
  const prices = rows.map(r => (typeof r[4] === "number" ? r[4] : null));
  const sma20 = [];
  for (let i = 0; i < prices.length; i++) {
    const window = [];
    for (let k = Math.max(0, i - 19); k <= i; k++) {
      if (typeof prices[k] === "number") window.push(prices[k]);
    }
    sma20.push(window.length >= 3 ? (window.reduce((a, b) => a + b, 0) / window.length) : null);
  }

  const buyIndices = [];
  const waitIndices = [];

  rows.forEach((r, i) => {
    const iv = r[1];
    const prem = r[2];
    const px = r[4];
    const sm = sma20[i];
    if (typeof prem !== "number") return;
    const pctile = pointInTimePercentile(rows, i);
    if (typeof pctile !== "number") return;

    const isTrendUp = (typeof px === "number" && typeof sm === "number" && px > sm);
    const stance = chooseStance(pctile, iv, { priceTrendUp: isTrendUp, fundamentalsResetOn: fundamentalsResetOn(rows, i) }, r[3]);

    if (stance.code === "BUY") {
      buyIndices.push(i);
    } else if (stance.code === "WAIT") {
      waitIndices.push(i);
    }
  });

  function groupConsecutive(indices) {
    if (!indices.length) return [];
    const windows = [];
    let startIdx = indices[0];
    let prevIdx = indices[0];

    for (let k = 1; k < indices.length; k++) {
      const currIdx = indices[k];
      const tPrev = Date.parse(rows[prevIdx][0]);
      const tCurr = Date.parse(rows[currIdx][0]);
      const daysDiff = (tCurr - tPrev) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 4.5) {
        prevIdx = currIdx;
      } else {
        windows.push({ startIdx, endIdx: prevIdx, count: prevIdx - startIdx + 1 });
        startIdx = currIdx;
        prevIdx = currIdx;
      }
    }
    windows.push({ startIdx, endIdx: prevIdx, count: prevIdx - startIdx + 1 });
    return windows;
  }

  return {
    buy: groupConsecutive(buyIndices),
    wait: groupConsecutive(waitIndices)
  };
}

function buildEtfInfoCardHtml(etfId, idx, isHover) {
  if (!currentSnapshot || !currentSnapshot.etfs) return "";
  const data = currentSnapshot.etfs[etfId];
  if (!data) return "";
  const rows = etfHistoryRows(etfId);
  const stats = historyStats(rows, DECISION_CONFIG, data.market_premium_pct);
  const dec = computeEtfDecision(data, stats);
  const backfilledUntil = etfHistory && etfHistory.backfilled_until;

  const basePrice = (rows.find(r => typeof r[4] === "number" && r[4] > 0) || [])[4];
  const latestPrice = dec.marketPrice || (rows.length && rows[rows.length - 1][4]);
  const totalReturn = (latestPrice && basePrice) ? ((latestPrice - basePrice) / basePrice) * 100 : null;
  const totalReturnStr = totalReturn !== null ? `${totalReturn >= 0 ? "+" : ""}${fmtNum(totalReturn, 1)}%` : "-";
  const totalReturnColor = totalReturn === null ? "#64748b" : (totalReturn < 0 ? "#cf222e" : "#16a34a");
  const totalReturnBadge = totalReturn !== null ? ` <span style="color:${totalReturnColor}; font-weight:700;">(${totalReturnStr})</span>` : "";

  if (isHover && rows && rows[idx]) {
    const r = rows[idx];
    const dateStr = r[0];
    const intrinsic = r[1];
    const premium = r[2];
    const covered = r[3];
    const histPrice = r[4];
    const histReturn = (histPrice && basePrice) ? ((histPrice - basePrice) / basePrice) * 100 : null;
    const histReturnStr = histReturn !== null ? `${histReturn >= 0 ? "+" : ""}${fmtNum(histReturn, 1)}%` : "-";
    const histReturnColor = histReturn === null ? "#64748b" : (histReturn < 0 ? "#cf222e" : "#16a34a");
    const histReturnBadge = histReturn !== null ? ` <span style="color:${histReturnColor}; font-weight:700;">(${histReturnStr})</span>` : "";

    const histPctile = pointInTimePercentile(rows, idx);

    const histWindow = [];
    for (let k = Math.max(0, idx - 19); k <= idx; k++) {
      if (typeof rows[k][4] === "number") histWindow.push(rows[k][4]);
    }
    const histSma20 = histWindow.length >= 3 ? (histWindow.reduce((a, b) => a + b, 0) / histWindow.length) : null;
    const isHistTrendUp = typeof histPrice === "number" && typeof histSma20 === "number" && histPrice > histSma20;

    const histStance = chooseStance(histPctile, intrinsic,
                                    { priceTrendUp: isHistTrendUp, fundamentalsResetOn: fundamentalsResetOn(rows, idx) }, covered);

    const isReconstructed = backfilledUntil && dateStr <= backfilledUntil;
    const premColor = premium < 0 ? "#16a34a" : "#cf222e";
    const diff = typeof data.market_premium_pct === "number" ? premium - data.market_premium_pct : null;
    const diffSign = diff !== null && diff >= 0 ? "+" : "";

    return `
      <div class="chart-card-header">
        <span class="chart-card-date">${escapeHtml(dateStr)}</span>
        <span class="chart-card-badge" style="${isReconstructed ? 'background:#fef3c7; color:#92400e;' : 'background:#e0f2fe; color:#0284c7;'}">
          ${isReconstructed ? "RECONSTRUCTED" : "INSPECTING"}
        </span>
      </div>
      <div class="chart-card-primary-val" style="color: ${premColor};">
        ${fmtPct(premium)}
        <span style="font-size: 0.76rem; font-weight: 600; color: #64748b; margin-left: 4px;">Prem vs DCF</span>
      </div>
      <div class="chart-card-sub-val">
        Intrinsic: <strong>$${fmtNum(intrinsic, 4)}</strong> per $1 NAV
      </div>

      <div class="chart-card-section-divider">
        <div class="chart-card-row">
          <span>Historical Premium:</span>
          <strong style="color: ${premColor};">${fmtPct(premium)}</strong>
        </div>
        <div class="chart-card-row">
          <span>ETF Market Price:</span>
          <span><strong>${histPrice ? `$${fmtNum(histPrice, 2)}` : "-"}</strong>${histReturnBadge}</span>
        </div>
        <div class="chart-card-row">
          <span>Diff vs Today:</span>
          <span><strong>${diff !== null ? `${diffSign}${fmtNum(diff, 1)}%` : "-"}</strong> pts</span>
        </div>
      </div>

      <div class="chart-card-section-divider">
        <div class="chart-card-row">
          <span>Stance Then:</span>
          <span class="stance-badge ${histStance.cls}" style="font-size:0.72rem; padding:1px 6px;">${histStance.icon} ${histStance.label}</span>
        </div>
        <div class="chart-card-row">
          <span>Stance Today:</span>
          <span class="stance-badge ${dec.stance.cls}" style="font-size:0.72rem; padding:1px 6px;">${dec.stance.icon} ${dec.stance.label}</span>
        </div>
        <div class="chart-card-row">
          <span>Market Price Today:</span>
          <strong>${dec.marketPrice !== null ? `$${fmtNum(dec.marketPrice, 2)} ${escapeHtml(dec.currency)}` : "-"}</strong>
        </div>
        <div class="chart-card-row">
          <span>1-Yr Total Return:</span>
          <strong style="color:${totalReturnColor};">${totalReturnStr}</strong>
        </div>
      </div>

      <div class="chart-card-footer">
        Point ${idx + 1} of ${rows.length} &bull; Release cursor to reset
      </div>
    `;
  }

  // Default: LATEST snapshot
  const premium = data.market_premium_pct;
  const premColor = typeof premium === "number" ? (premium < 0 ? "#16a34a" : "#cf222e") : "#1e293b";
  const dateStr = currentSnapshot.date || (rows.length ? rows[rows.length - 1][0] : "-");

  const priceText = dec.marketPrice !== null && dec.marketPrice !== undefined
    ? `$${fmtNum(dec.marketPrice, 2)} ${escapeHtml(dec.currency)}`
    : "N/A";

  const buyTargetText = dec.buyBelowPrice !== null
    ? `&le; $${fmtNum(dec.buyBelowPrice, 2)}`
    : (dec.targetPremium !== null ? `Prem &le; ${fmtPct(dec.targetPremium)}` : "N/A");

  return `
    <div class="chart-card-header">
      <span class="chart-card-date">${escapeHtml(dateStr)}</span>
      <span class="chart-card-badge">LATEST</span>
    </div>
    <div class="chart-card-primary-val" style="color: ${premColor};">
      ${fmtPct(premium)}
      <span style="font-size: 0.76rem; font-weight: 600; color: #64748b; margin-left: 4px;">Prem vs DCF</span>
    </div>

    <div class="chart-card-section-divider">
      <div class="chart-card-row">
        <span>Market Price:</span>
        <span><strong>${priceText}</strong>${totalReturnBadge}</span>
      </div>
      <div class="chart-card-row">
        <span>Buy-Below Target:</span>
        <span><strong>${buyTargetText}</strong> ${(() => {
          const tag = buyZoneTag(dec.stance, dec.distancePct);
          return tag ? `<span class="distance-tag ${tag.cls}" style="font-size:0.7rem; padding:1px 5px;">${escapeHtml(tag.text)}</span>` : "";
        })()}</span>
      </div>
      <div class="chart-card-row">
        <span>Decision Stance:</span>
        <span class="stance-badge ${dec.stance.cls}" style="font-size:0.72rem; padding:1px 6px;">${dec.stance.icon} ${dec.stance.label}</span>
      </div>
    </div>

    <div class="chart-card-section-divider">
      <div class="chart-card-row">
        <span>1-Yr Valuation Range:</span>
        <span>${stats ? `${fmtPct(stats.min)} to ${fmtPct(stats.max)}` : "-"}</span>
      </div>
      <div class="chart-card-row">
        <span>1-Yr %ile &bull; Median:</span>
        <span><strong>${stats ? `${Math.round(stats.percentile)}th` : "-"}</strong> %ile &bull; ${stats ? fmtPct(stats.median) : "-"}</span>
      </div>
    </div>

    <div class="chart-card-footer">
      💡 Hover over graph to inspect historical valuation &amp; price
    </div>
  `;
}

const UNVALUED_LABELS = {
  sector_excluded: "excluded sector (e.g. Financials)", negative_fcf: "negative free cash flow",
  debt_exceeds_value: "debt exceeds value", no_fundamentals: "no fundamentals", no_shares: "no share count",
  no_capex: "no capex data", no_fx_rate: "no FX rate", model_not_applicable: "model not applicable",
  no_price: "no price", no_valuation: "not valued"
};

function unvaluedTitle(data) {
  let text = "Share of portfolio weight with a valid DCF valuation.";
  const entries = Object.entries(data.unvalued_weight_pct || {});
  if (entries.length) {
    text += " Not valued: " + entries.map(([k, v]) => `${v}% ${UNVALUED_LABELS[k] || k}`).join(", ") + ".";
  }
  const zero = Object.entries(data.zero_value_weight_pct || {});
  if (zero.length) {
    text += " Counted at zero value: " + zero.map(([k, v]) => `${v}% ${UNVALUED_LABELS[k] || k}`).join(", ") + ".";
  }
  return text;
}

function renderEtfCards(list) {
  const container = document.getElementById("etf-cards-container");
  container.innerHTML = list.map(({ id, data, stats, dec }) => {
    const safeId = id.replace(/[^a-zA-Z0-9]/g, "_");

    return `
      <div class="etf-card" id="card-${safeId}">
        <div class="etf-card-header">
          <div>
            <div class="etf-card-title-row">
              <h3>${escapeHtml(data.name || id)}</h3>
            </div>
            <div class="etf-card-sub-row">
              <span class="etf-sym">${escapeHtml(id)}</span>
              <span class="badge etf-ccy">${escapeHtml(dec.currency)}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="stance-badge ${dec.stance.cls}">${dec.stance.icon} ${dec.stance.label}</span>
            <span class="badge" title="${escapeHtml(unvaluedTitle(data))}">${fmtNum(data.covered_weight_pct, 1)}% Valued</span>
            ${stats && stats.holdingsChangedOn ? `<span class="badge" title="The tickers behind this ETF's look-through changed, so earlier history is not exactly comparable">holdings changed ${escapeHtml(stats.holdingsChangedOn)}</span>` : ""}
            ${stats && stats.fundamentalsResetOn ? `<span class="badge" title="Intrinsic value per unit stepped more than ${DECISION_CONFIG.resetThresholdPct}% in a day without a matching price move (new filings or holdings entering or leaving the valuation). A bargain percentile is held at Accumulate for ${DECISION_CONFIG.resetCooldownRows} trading days after such a reset">fundamentals reset ${escapeHtml(stats.fundamentalsResetOn)}</span>` : ""}
          </div>
        </div>

        <div class="chart-layout-grid">
          <div class="chart-canvas-col">
            <div class="chart-container-rel">
              <div class="etf-chart" data-etf="${escapeHtml(id)}" id="chart-${safeId}"></div>
            </div>
            <div class="chart-card-footer" style="margin-top: 6px; border-top: none; justify-content: space-between; font-size: 0.74rem; color: #64748b;">
              <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                <span><span style="display:inline-block; width:12px; height:3px; background:#0969da; border-radius:1px; margin-right:5px; vertical-align:middle;"></span><strong>Valuation Prem vs DCF</strong> (Left &bull; <span style="color:#0969da;">&ndash;&ndash;</span> 0% Fair Value)</span>
                <span><span style="display:inline-block; width:12px; height:3px; background:#16a34a; border-radius:1px; margin-right:5px; vertical-align:middle;"></span><strong>ETF Market Price %</strong> (Right &bull; <span style="color:#16a34a;">&ndash;&ndash;</span> 0% Base)</span>
                <span><span style="display:inline-block; width:12px; height:10px; background:rgba(22,163,74,0.18); border:1px solid rgba(22,163,74,0.4); border-radius:2px; margin-right:5px; vertical-align:middle;"></span><strong>Buy Zone</strong></span>
                <span><span style="display:inline-block; width:12px; height:10px; background:rgba(234,179,8,0.22); border:1px solid rgba(234,179,8,0.5); border-radius:2px; margin-right:5px; vertical-align:middle;"></span><strong>Wait / Extended</strong></span>
              </div>
            </div>
          </div>
          <div class="chart-info-card" id="info-card-${safeId}">
            ${buildEtfInfoCardHtml(id, -1, false)}
          </div>
        </div>
      </div>
    `;
  }).join("");

  drawEtfCharts();
}

let allocatorState = {
  cash: 1000,
  strategy: "buy_zone",
  collapsed: false
};

function setupAllocator() {
  const cashInput = document.getElementById("allocator-cash-input");
  const strategySelect = document.getElementById("allocator-strategy-select");
  const toggleBtn = document.getElementById("allocator-toggle-btn");
  const bodyEl = document.getElementById("allocator-body");

  if (!cashInput || !strategySelect) return;

  cashInput.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) {
      allocatorState.cash = val;
      document.querySelectorAll(".quick-cash-btn").forEach(btn => {
        btn.classList.toggle("active", parseFloat(btn.dataset.amount) === val);
      });
      renderAllocator();
    }
  });

  document.querySelectorAll(".quick-cash-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const amt = parseFloat(btn.dataset.amount);
      allocatorState.cash = amt;
      cashInput.value = amt;
      document.querySelectorAll(".quick-cash-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderAllocator();
    });
  });

  strategySelect.addEventListener("change", (e) => {
    allocatorState.strategy = e.target.value;
    renderAllocator();
  });

  toggleBtn.addEventListener("click", () => {
    allocatorState.collapsed = !allocatorState.collapsed;
    bodyEl.style.display = allocatorState.collapsed ? "none" : "block";
    toggleBtn.textContent = allocatorState.collapsed ? "Expand Allocator" : "Collapse";
  });
}

function renderAllocator() {
  if (!currentSnapshot || !currentSnapshot.etfs) return;
  const resultsContainer = document.getElementById("allocator-results");
  if (!resultsContainer) return;

  // Buy signals only, or buy signals plus Accumulate (never Wait); etfRows() already ranks them
  const allowed = allocatorState.strategy === "buy_zone" ? ["BUY"] : ["BUY", "ACCUMULATE"];
  const candidates = etfRows().filter(e => allowed.includes(e.dec.stance.code) && typeof e.dec.marketPrice === "number");

  if (candidates.length === 0) {
    resultsContainer.innerHTML = `<p class="muted">No buy signals today. Switch to 'Buy Signals + Accumulate' to spread the cash over fairly valued funds instead.</p>`;
    return;
  }

  const cash = allocatorState.cash;
  const { orders, totalInvested, unusedCash } = computeAllocation(candidates, cash, allocatorState.strategy);

  // Plain-text for clipboard copy
  const clipText = [
    `StockEval Execution Orders (Cash: $${fmtNum(cash, 2)} CAD):`,
    ...orders.filter(o => o.shares > 0).map(o =>
      `- Buy ${o.shares} shares of ${o.etf.id} @ $${fmtNum(o.price, 2)} CAD = $${fmtNum(o.cost, 2)} CAD`),
    `Total Invested: $${fmtNum(totalInvested, 2)} CAD | Unused Cash: $${fmtNum(unusedCash, 2)} CAD`
  ].join("\n");

  resultsContainer.innerHTML = `
    <div class="allocator-summary-banner">
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Total to Deploy</span>
        <span class="allocator-stat-val">$${fmtNum(totalInvested, 2)}</span>
        <span class="allocator-stat-sub">${fmtNum((totalInvested / cash) * 100, 1)}% of $${fmtNum(cash, 0)} CAD</span>
      </div>
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Unused Cash</span>
        <span class="allocator-stat-val">$${fmtNum(unusedCash, 2)}</span>
        <span class="allocator-stat-sub">Remainder unspent</span>
      </div>
    </div>

    <div class="allocator-table-wrap">
      <table class="allocator-table">
        <thead>
          <tr>
            <th>ETF &amp; Stance</th>
            <th>Market Price</th>
            <th>Action Order</th>
            <th>Total Cost</th>
            <th>Allocation %</th>
            <th>Percentile</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(o => {
            const e = o.etf;
            const pct = totalInvested > 0 ? (o.cost / totalInvested) * 100 : 0;
            const sharesHtml = o.shares > 0
              ? `<strong>Buy ${o.shares} shares</strong>`
              : `<span class="muted">0 shares (price exceeds budget)</span>`;
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(e.id)}</strong>
                  <span class="stance-badge ${e.dec.stance.cls}" style="margin-left:6px;">${e.dec.stance.icon} ${e.dec.stance.label}</span>
                  <div class="muted" style="font-size:0.75rem;">${escapeHtml(e.data.name || "")}</div>
                </td>
                <td><strong>$${fmtNum(o.price, 2)}</strong> <span class="muted">CAD</span></td>
                <td>${sharesHtml}</td>
                <td><strong>$${fmtNum(o.cost, 2)} CAD</strong></td>
                <td>${fmtNum(pct, 1)}%</td>
                <td>${e.stats ? `${Math.round(e.stats.percentile)}th` : "-"}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>

    <div class="allocator-actions-row">
      <span id="copy-feedback-msg" class="copy-feedback" style="display:none;">✓ Copied buy orders to clipboard!</span>
      <button type="button" id="copy-orders-btn" class="btn-copy-orders">
        <span>📋</span> Copy Brokerage Orders
      </button>
    </div>
  `;

  document.getElementById("copy-orders-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(clipText).then(() => {
      const fb = document.getElementById("copy-feedback-msg");
      fb.style.display = "inline";
      setTimeout(() => { fb.style.display = "none"; }, 3000);
    }).catch(err => {
      console.error("Clipboard copy failed:", err);
    });
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceStep(range, target) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
}

function drawEtfCharts() {
  document.querySelectorAll(".etf-chart").forEach(el => drawEtfChart(el, etfHistoryRows(el.dataset.etf)));
}

function drawEtfChart(container, rows) {
  container.textContent = "";
  const etfId = container.dataset.etf;
  if (!etfId) return;
  const safeId = etfId.replace(/[^a-zA-Z0-9]/g, "_");
  const infoCard = document.getElementById(`info-card-${safeId}`);

  if (rows.length < 2) {
    container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:240px; color:#94a3b8; font-size:0.85rem;">Historical data not available for this ETF.</div>`;
    return;
  }

  const width = 1000;
  const height = 260;
  const m = { top: 20, right: 58, bottom: 28, left: 56 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;

  const times = rows.map(r => Date.parse(r[0]));
  const values = rows.map(r => r[2]);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const pad = (Math.max(vMax, 0) - Math.min(vMin, 0)) * 0.10 || 5;
  let lo = vMin < 0 ? vMin - pad : 0;
  let hi = vMax > 0 ? vMax + pad : 0;
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const t0 = times[0], t1 = times[times.length - 1];
  const x = t => m.left + ((t - t0) / (t1 - t0)) * w;
  const y = v => m.top + (1 - (v - lo) / (hi - lo)) * h;

  // Price calculations for overlay line
  const basePrice = (rows.find(r => typeof r[4] === "number" && r[4] > 0) || [])[4];
  const pricePcts = rows.map(r => (typeof r[4] === "number" && basePrice) ? ((r[4] - basePrice) / basePrice) * 100 : null);
  const validPcts = pricePcts.filter(v => typeof v === "number");

  let pLo = 0, pHi = 0, pStep = 5, yPrice = null;
  if (validPcts.length >= 2) {
    const pMin = Math.min(...validPcts);
    const pMax = Math.max(...validPcts);
    const pPad = (Math.max(pMax, 0) - Math.min(pMin, 0)) * 0.12 || 4;
    pLo = pMin < 0 ? pMin - pPad : 0;
    pHi = pMax > 0 ? pMax + pPad : 0;
    pStep = niceStep(pHi - pLo, 4);
    pLo = Math.floor(pLo / pStep) * pStep;
    pHi = Math.ceil(pHi / pStep) * pStep;
    yPrice = v => m.top + (1 - (v - pLo) / (pHi - pLo)) * h;
  }

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    style: "width: 100%; height: 280px; display: block; overflow: visible;",
    role: "img",
    "aria-label": `Valuation premium and market price return over the past year for ${etfId}`
  });

  const backfilledUntil = etfHistory && etfHistory.backfilled_until;
  if (backfilledUntil) {
    const bx = x(Math.min(Date.parse(backfilledUntil), t1));
    svg.appendChild(svgEl("rect", {
      x: m.left, y: m.top, width: Math.max(bx - m.left, 0), height: h,
      class: "chart-backfill"
    }));
  }

  // Shaded Historical Zones (Wait in Yellow, Buy in Green)
  const zoneWindows = computeHistoricalZoneWindows(rows);
  const dayW = w / Math.max(times.length - 1, 1);

  zoneWindows.wait.forEach(win => {
    const x1 = x(times[win.startIdx]);
    const x2 = x(times[win.endIdx]);
    const rectX = Math.max(m.left, x1 - dayW * 0.5);
    const rectW = Math.max(dayW, (x2 - x1) + dayW);
    svg.appendChild(svgEl("rect", {
      x: rectX,
      y: m.top,
      width: Math.min(rectW, m.left + w - rectX),
      height: h,
      class: "chart-wait-zone"
    }));
  });

  zoneWindows.buy.forEach(win => {
    const x1 = x(times[win.startIdx]);
    const x2 = x(times[win.endIdx]);
    const rectX = Math.max(m.left, x1 - dayW * 0.5);
    const rectW = Math.max(dayW, (x2 - x1) + dayW);
    svg.appendChild(svgEl("rect", {
      x: rectX,
      y: m.top,
      width: Math.min(rectW, m.left + w - rectX),
      height: h,
      class: "chart-buy-zone"
    }));
  });

  // Left Y-axis header (Prem %)
  const leftHdr = svgEl("text", {
    x: m.left - 8, y: m.top - 6,
    "text-anchor": "end", class: "chart-tick",
    style: "font-weight: 700; font-size: 9px;"
  });
  leftHdr.textContent = "PREM %";
  svg.appendChild(leftHdr);

  // Left Gridlines and Left Y ticks (Valuation %)
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.appendChild(svgEl("line", {
      x1: m.left, x2: m.left + w, y1: y(v), y2: y(v),
      class: v === 0 ? "chart-zero" : "chart-grid"
    }));
    const label = svgEl("text", {
      x: m.left - 8, y: y(v) + 3.5,
      "text-anchor": "end", class: "chart-tick"
    });
    label.textContent = `${v > 0 ? "+" : ""}${Math.round(v)}%`;
    svg.appendChild(label);
  }

  // Right Y-axis (Price Return %)
  if (yPrice) {
    const rightHdr = svgEl("text", {
      x: m.left + w + 8, y: m.top - 6,
      "text-anchor": "start", class: "chart-tick-price",
      style: "font-weight: 700; font-size: 9px;"
    });
    rightHdr.textContent = "PRICE %";
    svg.appendChild(rightHdr);

    // Green graph 0% baseline (ETF 1-Yr starting price base)
    if (pLo <= 0 && pHi >= 0) {
      svg.appendChild(svgEl("line", {
        x1: m.left, x2: m.left + w, y1: yPrice(0), y2: yPrice(0),
        class: "chart-zero-price"
      }));
    }

    for (let pv = pLo; pv <= pHi + 1e-9; pv += pStep) {
      const pLabel = svgEl("text", {
        x: m.left + w + 8, y: yPrice(pv) + 3.5,
        "text-anchor": "start", class: "chart-tick-price"
      });
      pLabel.textContent = `${pv > 0 ? "+" : ""}${Math.round(pv)}%`;
      svg.appendChild(pLabel);
    }
  }

  // Month ticks
  const d = new Date(t0);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  let monthIdx = 0;
  while (d.getTime() <= t1) {
    if (monthIdx % 2 === 0) {
      const tx = x(d.getTime());
      const label = svgEl("text", {
        x: tx, y: height - 8,
        "text-anchor": "middle", class: "chart-tick"
      });
      label.textContent = d.toLocaleDateString("en-CA", { month: "short", year: "2-digit", timeZone: "UTC" });
      svg.appendChild(label);
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
    monthIdx++;
  }

  // 1. Primary Line: Valuation Premium vs DCF
  const points = rows.map((r, i) => [x(times[i]), y(values[i])]);
  const linePath = points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  svg.appendChild(svgEl("path", {
    d: linePath,
    class: "chart-line"
  }));
  const lastValPt = points[points.length - 1];
  svg.appendChild(svgEl("circle", { cx: lastValPt[0], cy: lastValPt[1], r: 4.5, class: "chart-dot" }));

  // 2. Secondary Overlay Line: ETF Market Price Return %
  const pricePoints = [];
  if (yPrice) {
    rows.forEach((r, i) => {
      if (pricePcts[i] !== null) {
        pricePoints.push([x(times[i]), yPrice(pricePcts[i])]);
      }
    });
    if (pricePoints.length >= 2) {
      const pricePathD = pricePoints.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      svg.appendChild(svgEl("path", {
        d: pricePathD,
        class: "chart-line-price"
      }));
      const lastPricePt = pricePoints[pricePoints.length - 1];
      svg.appendChild(svgEl("circle", {
        cx: lastPricePt[0], cy: lastPricePt[1], r: 4.5,
        class: "chart-dot-price"
      }));
    }
  }

  // Crosshair vertical line + dual hover dots
  const cursorLine = svgEl("line", {
    y1: m.top, y2: m.top + h,
    stroke: "#94a3b8", "stroke-width": "1.5", "stroke-dasharray": "4,4",
    visibility: "hidden", "pointer-events": "none"
  });
  const hoverDot = svgEl("circle", {
    r: 5.5, fill: "#0969da", stroke: "#ffffff", "stroke-width": "2",
    visibility: "hidden", "pointer-events": "none"
  });
  const priceHoverDot = svgEl("circle", {
    r: 5.5, fill: "#16a34a", stroke: "#ffffff", "stroke-width": "2",
    visibility: "hidden", "pointer-events": "none"
  });
  svg.appendChild(cursorLine);
  svg.appendChild(hoverDot);
  svg.appendChild(priceHoverDot);

  // Full interactive tracking overlay
  const hit = svgEl("rect", {
    x: m.left, y: m.top, width: w, height: h,
    fill: "transparent",
    style: "cursor: crosshair; pointer-events: all;"
  });

  const show = evt => {
    let svgX = m.left;
    if (typeof svg.getScreenCTM === "function") {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = evt.clientX;
        pt.y = evt.clientY;
        const svgP = pt.matrixTransform(ctm.inverse());
        svgX = svgP.x;
      }
    } else {
      const rect = svg.getBoundingClientRect();
      svgX = (evt.clientX - (rect.left || 0)) * (width / (rect.width || 1));
    }

    const clampedX = Math.max(m.left, Math.min(m.left + w, svgX));
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < points.length; i++) {
      const diff = Math.abs(points[i][0] - clampedX);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    const idx = closestIdx;

    const [cx, cy] = points[idx];
    cursorLine.setAttribute("x1", cx.toFixed(1));
    cursorLine.setAttribute("x2", cx.toFixed(1));
    cursorLine.setAttribute("visibility", "visible");

    hoverDot.setAttribute("cx", cx.toFixed(1));
    hoverDot.setAttribute("cy", cy.toFixed(1));
    hoverDot.setAttribute("visibility", "visible");

    if (yPrice && pricePcts[idx] !== null) {
      priceHoverDot.setAttribute("cx", cx.toFixed(1));
      priceHoverDot.setAttribute("cy", yPrice(pricePcts[idx]).toFixed(1));
      priceHoverDot.setAttribute("visibility", "visible");
    } else {
      priceHoverDot.setAttribute("visibility", "hidden");
    }

    if (infoCard) {
      infoCard.innerHTML = buildEtfInfoCardHtml(etfId, idx, true);
      infoCard.classList.add("active");
    }
  };

  const hide = () => {
    cursorLine.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    priceHoverDot.setAttribute("visibility", "hidden");
    if (infoCard) {
      infoCard.innerHTML = buildEtfInfoCardHtml(etfId, rows.length - 1, false);
      infoCard.classList.remove("active");
    }
  };

  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerleave", hide);
  svg.appendChild(hit);

  container.appendChild(svg);
}

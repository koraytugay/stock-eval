// StockEval - ETF Fundamental Valuation & Decision Engine

let currentSnapshot = null;
let allHistoryDates = [];
let etfHistory = null;

// The dashboard lives in docs/ and reads data/ from the repo root; "data/" is kept as a fallback for other layouts.
const DATA_ROOTS = ["../data/", "data/"];
let dataRoot = null;

const ETF_CATEGORIES = {
  "TSE:XEQT": { category: "GLOBAL", label: "All-in-One Global", region: "Global" },
  "TSE:XUU":  { category: "US",     label: "US Total Market",  region: "US" },
  "TSE:XMC":  { category: "US",     label: "US Mid-Cap",       region: "US" },
  "TSE:XSMC": { category: "US",     label: "US Small-Cap",     region: "US" },
  "TSE:CAUS": { category: "FACTOR", label: "US All-Cap Value", region: "US" },
  "TSE:CAUV": { category: "FACTOR", label: "US Small-Cap Value", region: "US" },
  "TSE:ZLU":  { category: "FACTOR", label: "US Low Volatility",region: "US" },
  "TSE:XEF":  { category: "INTL",   label: "Int'l Developed",  region: "Developed ex-NA" },
  "TSE:CADE": { category: "INTL",   label: "Int'l Value Tilt", region: "Developed ex-NA" },
  "TSE:VIDY": { category: "INTL",   label: "Int'l High Dividend", region: "Developed ex-NA" },
  "TSE:ZLI":  { category: "FACTOR", label: "Int'l Low Volatility", region: "Developed ex-NA" },
  "VXUS":     { category: "INTL",   label: "Total World ex-US",region: "Global ex-US" },
  "TSE:XEC":  { category: "EM",     label: "Emerging Markets", region: "Emerging" },
  "TSE:CAEM": { category: "EM",     label: "EM Value Tilt",    region: "Emerging" },
  "TSE:CASV": { category: "FACTOR", label: "Global Small-Cap Value", region: "Global" },
  "TSE:CACE": { category: "CANADA", label: "Canadian Value",   region: "Canada" },
};

function getEtfCategory(id) {
  return ETF_CATEGORIES[id] || { category: "OTHER", label: "Equity ETF", region: "Other" };
}

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  setupAllocator();
  await loadHistoryIndex();
  etfHistory = await fetchData("etf_history.json").catch(() => null);
  await loadSnapshot("latest");
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

function median(values) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

function setupEventListeners() {
  document.getElementById("etf-search-input").addEventListener("input", renderEtfs);
  document.getElementById("filter-category").addEventListener("change", renderEtfs);
  document.getElementById("etf-sort-by").addEventListener("change", renderEtfs);
  document.getElementById("snapshot-select").addEventListener("change", (e) => {
    loadSnapshot(e.target.value);
  });
}

async function loadHistoryIndex() {
  try {
    allHistoryDates = await fetchData("history_index.json");
    const options = allHistoryDates.slice().reverse()
      .map(date => `<option value="${escapeHtml(date)}">${escapeHtml(date)}</option>`).join("");
    document.getElementById("snapshot-select").innerHTML = `<option value="latest">Latest Snapshot</option>${options}`;
  } catch (err) {
    console.warn("Could not load history index, fallback to latest:", err);
  }
}

async function loadSnapshot(dateOrLatest) {
  const path = dateOrLatest === "latest" ? "latest.json" : `snapshots/${dateOrLatest}.json`;
  try {
    currentSnapshot = await fetchData(path);
    document.getElementById("last-updated").textContent = `Snapshot: ${currentSnapshot.date || dateOrLatest}`;
    updateKPIs();
    renderEtfs();
    setupAllocatorChips();
    renderAllocator();
  } catch (err) {
    console.error("Failed to load snapshot:", err);
    document.getElementById("last-updated").textContent = "Error loading snapshot";
    document.querySelector("#etf-summary-table tbody").innerHTML =
      `<tr><td colspan="9" class="loading">Could not load snapshot data.</td></tr>`;
  }
}

function etfHistoryRows(etfId) {
  return ((etfHistory && etfHistory.etfs && etfHistory.etfs[etfId]) || []).filter(r => typeof r[2] === "number");
}

function historyStats(rows) {
  if (!rows || rows.length < 5) return null;
  const premiums = rows.map(r => r[2]);
  const current = premiums[premiums.length - 1];
  const sorted = premiums.slice().sort((a, b) => a - b);
  const percentile = (premiums.filter(p => p <= current).length / premiums.length) * 100;
  const p20 = sorted[Math.floor(sorted.length * 0.20)];
  return {
    current,
    percentile,
    p20,
    min: Math.min(...premiums),
    max: Math.max(...premiums),
    median: median(premiums)
  };
}

function getEtfFundamentals(etfObj) {
  if (typeof etfObj.fcf_yield_pct === "number" && typeof etfObj.implied_growth_pct === "number") {
    return {
      fcfYield: etfObj.fcf_yield_pct,
      impliedGrowth: etfObj.implied_growth_pct
    };
  }

  // Fallback computation from snapshot stocks
  const stocks = (currentSnapshot && currentSnapshot.stocks) || {};
  const holdings = etfObj.holdings || [];
  let totWeight = 0;
  let weightedYield = 0;
  let gWeight = 0;
  let weightedGrowth = 0;

  for (const h of holdings) {
    const s = stocks[h.ticker];
    if (!s) continue;
    const val = s.valuation || {};
    const raw = s.raw || {};
    const fcf = val.fcf_used ?? raw.free_cash_flow;
    const shares = raw.shares_outstanding;
    const price = s.market_price;
    const fx = val.fx_rate || 1.0;
    const adr = val.adr_ratio || 1.0;
    const revG = val.implied_growth_reverse_dcf;

    if (fcf && shares && shares > 0 && price && price > 0) {
      const fcfPerShare = (fcf / shares) * fx * adr;
      const fcfYield = (fcfPerShare / price) * 100.0;
      weightedYield += h.weight * fcfYield;
      totWeight += h.weight;
    }

    if (typeof revG === "number") {
      weightedGrowth += h.weight * (revG * 100.0);
      gWeight += h.weight;
    }
  }

  return {
    fcfYield: totWeight > 0 ? (weightedYield / totWeight) : null,
    impliedGrowth: gWeight > 0 ? (weightedGrowth / gWeight) : null
  };
}

function computeEtfDecision(data, stats) {
  const premium = data.market_premium_pct;
  const intrinsicPerDollar = data.intrinsic_per_dollar;
  const marketPrice = data.market_price;
  const currency = data.currency || "CAD";
  const percentile = stats ? stats.percentile : null;
  const p20 = stats ? stats.p20 : null;
  const funds = getEtfFundamentals(data);

  // Target premium threshold for a bargain entry:
  // If the ETF is at an absolute discount (intrinsic >= 1.0), bargain is at least fair value (0% premium).
  // Otherwise, target is its 20th percentile historical level.
  let targetPremium = p20;
  if (typeof intrinsicPerDollar === "number" && intrinsicPerDollar >= 1.0 && typeof p20 === "number") {
    targetPremium = Math.min(0, p20);
  }

  let fairValuePrice = null;
  let buyBelowPrice = null;
  let distancePct = null;

  if (typeof marketPrice === "number" && typeof premium === "number") {
    const intrinsicPrice = marketPrice / (1.0 + premium / 100.0);
    fairValuePrice = intrinsicPrice;

    if (typeof targetPremium === "number") {
      buyBelowPrice = intrinsicPrice * (1.0 + targetPremium / 100.0);
      distancePct = ((marketPrice - buyBelowPrice) / buyBelowPrice) * 100.0;
    }
  }

  let stance = { code: "WAIT", label: "Wait / Extended", cls: "stance-wait", icon: "⏸", rank: 3 };

  if (typeof percentile === "number") {
    if (percentile <= 20 || (typeof intrinsicPerDollar === "number" && intrinsicPerDollar >= 1.0 && percentile <= 50)) {
      stance = { code: "BUY", label: "Strong Value / Buy", cls: "stance-buy", icon: "✓", rank: 1 };
    } else if (percentile <= 65) {
      stance = { code: "ACCUMULATE", label: "Fair / Accumulate", cls: "stance-accumulate", icon: "◈", rank: 2 };
    } else {
      stance = { code: "WAIT", label: "Wait / Extended", cls: "stance-wait", icon: "⏸", rank: 3 };
    }
  }

  return {
    stance,
    fairValuePrice,
    buyBelowPrice,
    distancePct,
    targetPremium,
    marketPrice,
    currency,
    fcfYield: funds.fcfYield,
    impliedGrowth: funds.impliedGrowth
  };
}

function verdict(percentile) {
  if (typeof percentile !== "number") return null;
  if (percentile <= 20) return { label: "Cheaper than usual", cls: "verdict-cheap", icon: "\u2193" };
  if (percentile >= 80) return { label: "Pricier than usual", cls: "verdict-pricey", icon: "\u2191" };
  return { label: "Typical", cls: "verdict-typical", icon: "\u2013" };
}

function updateKPIs() {
  if (!currentSnapshot || !currentSnapshot.etfs) return;
  const etfs = Object.entries(currentSnapshot.etfs);
  const etfRows = etfs.map(([id, data]) => {
    const stats = historyStats(etfHistoryRows(id));
    return {
      id,
      data,
      stats,
      dec: computeEtfDecision(data, stats),
      catInfo: getEtfCategory(id)
    };
  });

  // 1. Active Buy Triggers
  const buyCount = etfRows.filter(e => e.dec.stance.code === "BUY").length;
  document.getElementById("kpi-etf-count").textContent = `${buyCount} in Buy Zone`;
  document.getElementById("kpi-etf-sub").textContent = `${buyCount} of ${etfs.length} funds meet buy triggers`;

  // 2. Median FCF Yield
  const fcfYields = etfRows.map(e => e.dec.fcfYield).filter(y => typeof y === "number");
  const medFcf = fcfYields.length ? median(fcfYields) : null;
  const medFcfEl = document.getElementById("kpi-median-fcf");
  medFcfEl.textContent = typeof medFcf === "number" ? `${fmtNum(medFcf, 2)}%` : "-";
  medFcfEl.className = "kpi-value fcf-highlight";
  const highYield = etfRows.filter(e => typeof e.dec.fcfYield === "number").sort((a, b) => b.dec.fcfYield - a.dec.fcfYield);
  const topFcf = highYield.length ? highYield[0] : null;
  document.getElementById("kpi-median-fcf-sub").textContent = topFcf
    ? `Top: ${topFcf.id.replace("TSE:", "")} (${fmtNum(topFcf.dec.fcfYield, 1)}% cash yield)`
    : "Look-through cash return";

  // 3. Top Value Opportunity (Lowest percentile vs 1-year history)
  const withStats = etfRows.filter(e => e.stats !== null);
  if (withStats.length > 0) {
    const bestRel = withStats.reduce((a, b) => (b.stats.percentile < a.stats.percentile ? b : a));
    const sym = bestRel.id.replace("TSE:", "");
    document.getElementById("kpi-best-relative").textContent = `${sym} (${Math.round(bestRel.stats.percentile)}th %)`;
    document.getElementById("kpi-best-relative-sub").textContent = `${bestRel.data.name || sym} · ${fmtPct(bestRel.data.market_premium_pct)}`;
  } else {
    document.getElementById("kpi-best-relative").textContent = "-";
    document.getElementById("kpi-best-relative-sub").textContent = "Awaiting history";
  }

  // 4. Deepest DCF Discount (Lowest premium vs DCF)
  const valuedEtfs = etfRows.filter(e => typeof e.data.market_premium_pct === "number");
  if (valuedEtfs.length > 0) {
    const deepest = valuedEtfs.reduce((a, b) => (b.data.market_premium_pct < a.data.market_premium_pct ? b : a));
    const sym = deepest.id.replace("TSE:", "");
    const dEl = document.getElementById("kpi-deepest-discount");
    dEl.textContent = `${sym} (${fmtPct(deepest.data.market_premium_pct)})`;
    dEl.className = `kpi-value ${deepest.data.market_premium_pct < 0 ? "premium-discount" : "premium-expensive"}`;
    document.getElementById("kpi-deepest-discount-sub").textContent = `$${fmtNum(deepest.data.intrinsic_per_dollar, 2)} intrinsic per $1 invested`;
  } else {
    document.getElementById("kpi-deepest-discount").textContent = "-";
    document.getElementById("kpi-deepest-discount-sub").textContent = "-";
  }
}

function getFilteredAndSortedEtfs() {
  if (!currentSnapshot || !currentSnapshot.etfs) return [];
  const searchQuery = (document.getElementById("etf-search-input").value || "").trim().toUpperCase();
  const categoryFilter = document.getElementById("filter-category").value;
  const sortBy = document.getElementById("etf-sort-by").value;

  let list = Object.entries(currentSnapshot.etfs).map(([id, data]) => {
    const stats = historyStats(etfHistoryRows(id));
    return {
      id,
      data,
      stats,
      dec: computeEtfDecision(data, stats),
      catInfo: getEtfCategory(id)
    };
  });

  if (searchQuery) {
    list = list.filter(e =>
      e.id.toUpperCase().includes(searchQuery) ||
      (e.data.name && e.data.name.toUpperCase().includes(searchQuery)) ||
      e.catInfo.label.toUpperCase().includes(searchQuery)
    );
  }

  if (categoryFilter !== "ALL") {
    list = list.filter(e => e.catInfo.category === categoryFilter);
  }

  list.sort((a, b) => {
    if (sortBy === "stance_asc") {
      const rA = a.dec.stance.rank ?? 9;
      const rB = b.dec.stance.rank ?? 9;
      if (rA !== rB) return rA - rB;
      return (a.stats ? a.stats.percentile : 999) - (b.stats ? b.stats.percentile : 999);
    } else if (sortBy === "distance_asc") {
      return (a.dec.distancePct ?? 9999) - (b.dec.distancePct ?? 9999);
    } else if (sortBy === "fcf_yield_desc") {
      return (b.dec.fcfYield ?? -999) - (a.dec.fcfYield ?? -999);
    } else if (sortBy === "growth_asc") {
      return (a.dec.impliedGrowth ?? 999) - (b.dec.impliedGrowth ?? 999);
    } else if (sortBy === "percentile_asc") {
      const pA = a.stats ? a.stats.percentile : 999;
      const pB = b.stats ? b.stats.percentile : 999;
      return pA - pB;
    } else if (sortBy === "premium_asc") {
      return (a.data.market_premium_pct ?? 9999) - (b.data.market_premium_pct ?? 9999);
    } else if (sortBy === "intrinsic_desc") {
      return (b.data.intrinsic_per_dollar ?? -9999) - (a.data.intrinsic_per_dollar ?? -9999);
    } else if (sortBy === "name_asc") {
      return (a.data.name || a.id).localeCompare(b.data.name || b.id);
    }
    return 0;
  });

  return list;
}

function renderEtfs() {
  if (!currentSnapshot || !currentSnapshot.etfs) return;
  const list = getFilteredAndSortedEtfs();
  const total = Object.keys(currentSnapshot.etfs).length;
  document.getElementById("etf-result-count").textContent = `Showing ${list.length} of ${total} tracked ETFs.`;
  document.getElementById("etf-backfill-date").textContent = (etfHistory && etfHistory.backfilled_until) || "-";

  renderEtfSummary(list);
  renderEtfCards(list);
}

function renderEtfSummary(list) {
  const tbody = document.querySelector("#etf-summary-table tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading">No ETFs match the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(({ id, data, stats, dec, catInfo }) => {
    const premium = data.market_premium_pct;
    const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";

    const priceHtml = dec.marketPrice !== null && dec.marketPrice !== undefined
      ? `<strong>$${fmtNum(dec.marketPrice, 2)}</strong> <span class="muted">${escapeHtml(dec.currency)}</span>`
      : "-";

    const fairValueHtml = dec.fairValuePrice !== null && dec.fairValuePrice !== undefined
      ? `<strong>$${fmtNum(dec.fairValuePrice, 2)}</strong><div class="muted" style="font-size:0.75rem;">$${fmtNum(data.intrinsic_per_dollar, 2)} / $1</div>`
      : (data.intrinsic_per_dollar ? `$${fmtNum(data.intrinsic_per_dollar, 2)} / $1` : "-");

    let buyBelowHtml = "-";
    if (dec.buyBelowPrice !== null && dec.buyBelowPrice !== undefined) {
      const inZone = dec.distancePct <= 0;
      const tagCls = inZone ? "distance-in-zone" : "distance-above";
      const tagText = inZone ? "In Buy Zone!" : `+${fmtNum(dec.distancePct, 1)}%`;
      buyBelowHtml = `
        <strong>&le; $${fmtNum(dec.buyBelowPrice, 2)}</strong>
        <div><span class="distance-tag ${tagCls}">${tagText}</span></div>
      `;
    } else if (dec.targetPremium !== null && dec.targetPremium !== undefined) {
      buyBelowHtml = `Prem &le; ${fmtPct(dec.targetPremium)}`;
    }

    const fcfCls = typeof dec.fcfYield === "number" && dec.fcfYield >= 5.0 ? "fcf-highlight" : "";
    const fcfText = typeof dec.fcfYield === "number" ? `<strong class="${fcfCls}">${fmtNum(dec.fcfYield, 2)}%</strong>` : `<span class="muted">-</span>`;

    const gCls = typeof dec.impliedGrowth === "number"
      ? (dec.impliedGrowth <= 10.0 ? "hurdle-low" : (dec.impliedGrowth >= 25.0 ? "hurdle-high" : ""))
      : "";
    const gText = typeof dec.impliedGrowth === "number" ? `<strong class="${gCls}">${fmtNum(dec.impliedGrowth, 1)}%</strong>` : `<span class="muted">-</span>`;

    return `
      <tr>
        <td>
          <strong>${escapeHtml(id)}</strong>
          <span class="status-note">${escapeHtml(data.name || "")}</span>
        </td>
        <td><span class="category-badge">${escapeHtml(catInfo.label)}</span></td>
        <td><span class="stance-badge ${dec.stance.cls}"><span aria-hidden="true">${dec.stance.icon}</span> ${dec.stance.label}</span></td>
        <td>${priceHtml}</td>
        <td>${fairValueHtml}</td>
        <td>${buyBelowHtml}</td>
        <td class="${premiumClass}"><strong>${fmtPct(premium)}</strong></td>
        <td>${fcfText}</td>
        <td>${gText}</td>
        <td>${stats ? `${fmtPct(stats.min)} to ${fmtPct(stats.max)}` : "-"}</td>
        <td><strong>${stats ? `${Math.round(stats.percentile)}th` : "-"}</strong></td>
      </tr>
    `;
  }).join("");
}

function computeHistoricalZoneWindows(rows) {
  if (!rows || rows.length < 5) return { buy: [], wait: [] };
  const premiums = rows.map(r => r[2]).filter(p => typeof p === "number");
  if (!premiums.length) return { buy: [], wait: [] };
  const n = premiums.length;

  const buyIndices = [];
  const waitIndices = [];

  rows.forEach((r, i) => {
    const iv = r[1];
    const prem = r[2];
    if (typeof prem !== "number") return;
    const pctile = (premiums.filter(p => p <= prem).length / n) * 100;
    const isBuy = (pctile <= 20) || (typeof iv === "number" && iv >= 1.0 && pctile <= 50);
    if (isBuy) {
      buyIndices.push(i);
    } else if (pctile > 65) {
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
  const stats = historyStats(rows);
  const dec = computeEtfDecision(data, stats);
  const inZone = dec.distancePct !== null && dec.distancePct <= 0;
  const backfilledUntil = etfHistory && etfHistory.backfilled_until;

  const basePrice = (rows.find(r => typeof r[4] === "number" && r[4] > 0) || [])[4];
  const latestPrice = dec.marketPrice || (rows.length && rows[rows.length - 1][4]);
  const totalReturn = (latestPrice && basePrice) ? ((latestPrice - basePrice) / basePrice) * 100 : null;
  const totalReturnStr = totalReturn !== null ? `${totalReturn >= 0 ? "+" : ""}${fmtNum(totalReturn, 1)}%` : "-";

  if (isHover && rows && rows[idx]) {
    const r = rows[idx];
    const dateStr = r[0];
    const intrinsic = r[1];
    const premium = r[2];
    const covered = r[3];
    const histPrice = r[4];
    const histReturn = (histPrice && basePrice) ? ((histPrice - basePrice) / basePrice) * 100 : null;
    const histReturnStr = histReturn !== null ? `${histReturn >= 0 ? "+" : ""}${fmtNum(histReturn, 1)}%` : "-";

    const allPrems = rows.map(row => row[2]).filter(p => typeof p === "number");
    const histPctile = (allPrems.filter(p => p <= premium).length / allPrems.length) * 100;
    let histStance = { code: "WAIT", label: "Wait / Extended", cls: "stance-wait", icon: "⏸" };
    if (histPctile <= 20 || (typeof intrinsic === "number" && intrinsic >= 1.0 && histPctile <= 50)) {
      histStance = { code: "BUY", label: "Strong Value / Buy", cls: "stance-buy", icon: "✓" };
    } else if (histPctile <= 65) {
      histStance = { code: "ACCUMULATE", label: "Fair / Accumulate", cls: "stance-accumulate", icon: "◈" };
    }

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
          <span><strong>${histPrice ? `$${fmtNum(histPrice, 2)}` : "-"}</strong> <span style="color:#16a34a; font-weight:700;">(${histReturnStr})</span></span>
        </div>
        <div class="chart-card-row">
          <span>Intrinsic / $1 NAV:</span>
          <strong>$${fmtNum(intrinsic, 4)}</strong>
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
          <strong style="color:#16a34a;">${totalReturnStr}</strong>
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

  const fairValueText = dec.fairValuePrice !== null && dec.fairValuePrice !== undefined
    ? `$${fmtNum(dec.fairValuePrice, 2)}`
    : (data.intrinsic_per_dollar ? `$${fmtNum(data.intrinsic_per_dollar, 4)} / $1` : "N/A");

  const buyTargetText = dec.buyBelowPrice !== null && dec.buyBelowPrice !== undefined
    ? `&le; $${fmtNum(dec.buyBelowPrice, 2)}`
    : (dec.targetPremium !== null ? `Prem &le; ${fmtPct(dec.targetPremium)}` : "N/A");

  const fcfText = typeof dec.fcfYield === "number" ? `${fmtNum(dec.fcfYield, 2)}%` : "-";
  const growthText = typeof dec.impliedGrowth === "number" ? `${fmtNum(dec.impliedGrowth, 1)}% / yr` : "-";

  return `
    <div class="chart-card-header">
      <span class="chart-card-date">${escapeHtml(dateStr)}</span>
      <span class="chart-card-badge">LATEST</span>
    </div>
    <div class="chart-card-primary-val" style="color: ${premColor};">
      ${fmtPct(premium)}
      <span style="font-size: 0.76rem; font-weight: 600; color: #64748b; margin-left: 4px;">Prem vs DCF</span>
    </div>
    <div class="chart-card-sub-val">
      DCF Fair Value: <strong>${fairValueText}</strong> <span class="muted">($${fmtNum(data.intrinsic_per_dollar, 2)} / $1)</span>
    </div>

    <div class="chart-card-section-divider">
      <div class="chart-card-row">
        <span>Market Price:</span>
        <span><strong>${priceText}</strong> <span style="color:#16a34a; font-weight:700;">(${totalReturnStr})</span></span>
      </div>
      <div class="chart-card-row">
        <span>DCF Fair Value:</span>
        <strong>${fairValueText}</strong>
      </div>
      <div class="chart-card-row">
        <span>Buy-Below Target:</span>
        <span><strong>${buyTargetText}</strong> ${dec.distancePct !== null ? `<span class="distance-tag ${inZone ? 'distance-in-zone' : 'distance-above'}" style="font-size:0.7rem; padding:1px 5px;">${inZone ? 'In Zone!' : `+${fmtNum(dec.distancePct, 1)}%`}</span>` : ''}</span>
      </div>
      <div class="chart-card-row">
        <span>Decision Stance:</span>
        <span class="stance-badge ${dec.stance.cls}" style="font-size:0.72rem; padding:1px 6px;">${dec.stance.icon} ${dec.stance.label}</span>
      </div>
    </div>

    <div class="chart-card-section-divider">
      <div class="chart-card-row">
        <span>Portfolio FCF Yield:</span>
        <strong class="${dec.fcfYield >= 5 ? 'fcf-highlight' : ''}">${fcfText}</strong>
      </div>
      <div class="chart-card-row">
        <span>Implied Growth Hurdle:</span>
        <strong class="${dec.impliedGrowth <= 10 ? 'hurdle-low' : (dec.impliedGrowth >= 25 ? 'hurdle-high' : '')}">${growthText}</strong>
      </div>
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

function renderEtfCards(list) {
  const container = document.getElementById("etf-cards-container");
  if (!list.length) {
    container.innerHTML = `<p class="placeholder-text">No ETFs match the selected search or filters.</p>`;
    return;
  }

  container.innerHTML = list.map(({ id, data, stats, dec, catInfo }) => {
    const safeId = id.replace(/[^a-zA-Z0-9]/g, "_");

    return `
      <div class="etf-card" id="card-${safeId}">
        <div class="etf-card-header">
          <div>
            <div class="etf-card-title-row">
              <h3>${escapeHtml(data.name || id)}</h3>
              <span class="category-badge">${escapeHtml(catInfo.label)}</span>
            </div>
            <div class="etf-card-sub-row">
              <span class="etf-sym">${escapeHtml(id)}</span>
              <span class="badge etf-ccy">${escapeHtml(dec.currency)}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="stance-badge ${dec.stance.cls}">${dec.stance.icon} ${dec.stance.label}</span>
            <span class="badge" title="Share of portfolio weight with a valid DCF valuation">${fmtNum(data.covered_weight_pct, 1)}% Valued</span>
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
  customSelected: new Set(["TSE:CAEM", "TSE:XEC", "TSE:ZLI"]),
  collapsed: false
};

function setupAllocator() {
  const cashInput = document.getElementById("allocator-cash-input");
  const strategySelect = document.getElementById("allocator-strategy-select");
  const toggleBtn = document.getElementById("allocator-toggle-btn");
  const bodyEl = document.getElementById("allocator-body");
  const chipsWrap = document.getElementById("allocator-custom-chips");

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
    chipsWrap.style.display = allocatorState.strategy === "custom" ? "block" : "none";
    renderAllocator();
  });

  toggleBtn.addEventListener("click", () => {
    allocatorState.collapsed = !allocatorState.collapsed;
    bodyEl.style.display = allocatorState.collapsed ? "none" : "block";
    toggleBtn.textContent = allocatorState.collapsed ? "Expand Allocator" : "Collapse";
  });
}

function setupAllocatorChips() {
  const container = document.getElementById("allocator-chips-container");
  if (!container || !currentSnapshot || !currentSnapshot.etfs) return;
  const etfs = Object.entries(currentSnapshot.etfs);

  container.innerHTML = etfs.map(([id, data]) => {
    const isSelected = allocatorState.customSelected.has(id);
    const stats = historyStats(etfHistoryRows(id));
    const dec = computeEtfDecision(data, stats);
    return `
      <div class="allocator-chip ${isSelected ? "selected" : "unselected"}" data-etf="${escapeHtml(id)}">
        <strong>${escapeHtml(id.replace("TSE:", ""))}</strong>
        <span class="stance-badge ${dec.stance.cls}" style="font-size:0.68rem; padding:1px 5px; margin-left:4px;">${dec.stance.icon} ${dec.stance.label}</span>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".allocator-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.etf;
      if (allocatorState.customSelected.has(id)) {
        if (allocatorState.customSelected.size > 1) {
          allocatorState.customSelected.delete(id);
        }
      } else {
        allocatorState.customSelected.add(id);
      }
      setupAllocatorChips();
      renderAllocator();
    });
  });
}

function renderAllocator() {
  if (!currentSnapshot || !currentSnapshot.etfs) return;
  const resultsContainer = document.getElementById("allocator-results");
  if (!resultsContainer) return;

  const etfs = Object.entries(currentSnapshot.etfs);
  const etfRows = etfs.map(([id, data]) => {
    const stats = historyStats(etfHistoryRows(id));
    return {
      id,
      data,
      stats,
      dec: computeEtfDecision(data, stats),
      catInfo: getEtfCategory(id)
    };
  });

  // Filter candidates based on strategy
  let candidates = [];
  const strat = allocatorState.strategy;

  if (strat === "buy_zone") {
    // Strictly Buy Zone ETFs only (Stance === BUY)
    candidates = etfRows
      .filter(e => e.dec.stance.code === "BUY" && typeof e.dec.marketPrice === "number")
      .sort((a, b) => (a.stats ? a.stats.percentile : 999) - (b.stats ? b.stats.percentile : 999));
  } else if (strat === "buy_and_accumulate") {
    // Buy Zone + Fair Value Accumulate (strictly NO Wait ETFs)
    candidates = etfRows
      .filter(e => (e.dec.stance.code === "BUY" || e.dec.stance.code === "ACCUMULATE") && typeof e.dec.marketPrice === "number")
      .sort((a, b) => {
        if (a.dec.stance.rank !== b.dec.stance.rank) return a.dec.stance.rank - b.dec.stance.rank;
        return (a.stats ? a.stats.percentile : 999) - (b.stats ? b.stats.percentile : 999);
      });
  } else if (strat === "buy_and_core") {
    // 50% Core (XEQT) + 50% Buy Zone funds
    const buyZoneFunds = etfRows
      .filter(e => e.dec.stance.code === "BUY" && typeof e.dec.marketPrice === "number")
      .sort((a, b) => (a.stats ? a.stats.percentile : 999) - (b.stats ? b.stats.percentile : 999));
    const coreFund = etfRows.find(e => e.id === "TSE:XEQT" && typeof e.dec.marketPrice === "number");
    candidates = coreFund ? [coreFund, ...buyZoneFunds] : buyZoneFunds;
  } else if (strat === "custom") {
    candidates = etfRows.filter(e => allocatorState.customSelected.has(e.id) && typeof e.dec.marketPrice === "number");
  }

  if (candidates.length === 0) {
    resultsContainer.innerHTML = `<p class="muted">No ETFs currently qualify under this strategy. Switch to 'Buy Zone + Fair Value Accumulate' or 'Custom Selection'.</p>`;
    return;
  }

  const cash = allocatorState.cash;

  // Compute weights
  let weights = [];
  if (strat === "buy_and_core" && candidates.some(c => c.id === "TSE:XEQT")) {
    const coreShare = 0.50;
    const otherCount = Math.max(candidates.length - 1, 1);
    const otherShareEach = (1.0 - coreShare) / otherCount;
    weights = candidates.map(c => c.id === "TSE:XEQT" ? coreShare : otherShareEach);
  } else if (strat === "buy_and_accumulate") {
    // Give BUY zone ETFs 2.5x more weight than ACCUMULATE
    weights = candidates.map(c => {
      const base = (100.0 - (c.stats ? c.stats.percentile : 50)) * Math.max(c.data.intrinsic_per_dollar || 1.0, 0.4);
      return c.dec.stance.code === "BUY" ? base * 2.5 : base;
    });
  } else {
    // Proportional to bargain opportunity: lower historical percentile & higher intrinsic value get higher weight
    weights = candidates.map(c => {
      const pctile = c.stats ? c.stats.percentile : 50;
      return (100.0 - pctile) * Math.max(c.data.intrinsic_per_dollar || 1.0, 0.5);
    });
  }
  const totWeight = weights.reduce((s, w) => s + w, 0) || 1;

  // Initial share allocation
  let orders = candidates.map((c, i) => {
    const w = weights[i] / totWeight;
    const targetDollars = cash * w;
    const p = c.dec.marketPrice;
    const shares = Math.floor(targetDollars / p);
    const cost = shares * p;
    return {
      etf: c,
      targetDollars,
      shares,
      price: p,
      cost,
      score: weights[i]
    };
  });

  // Remainder pass: allocate unspent dollars to candidate with highest value score if price fits
  let spent = orders.reduce((s, o) => s + o.cost, 0);
  let rem = cash - spent;
  const sortedOrdersByScore = orders.slice().sort((a, b) => b.score - a.score);

  for (const o of sortedOrdersByScore) {
    while (rem >= o.price) {
      o.shares += 1;
      o.cost += o.price;
      rem -= o.price;
      spent += o.price;
    }
  }

  const totalInvested = spent;
  const unusedCash = Math.max(0, cash - totalInvested);

  // Compute weighted metrics of this purchase
  let sumFcf = 0;
  let sumPrem = 0;
  let costWithStats = 0;

  for (const o of orders) {
    if (o.cost > 0) {
      if (typeof o.etf.dec.fcfYield === "number") {
        sumFcf += o.cost * o.etf.dec.fcfYield;
      }
      if (typeof o.etf.data.market_premium_pct === "number") {
        sumPrem += o.cost * o.etf.data.market_premium_pct;
        costWithStats += o.cost;
      }
    }
  }

  const weightedFcf = totalInvested > 0 ? (sumFcf / totalInvested) : null;
  const weightedPrem = costWithStats > 0 ? (sumPrem / costWithStats) : null;

  // Plain-text for clipboard copy
  const clipText = [
    `StockEval Execution Orders (Cash: $${fmtNum(cash, 2)} CAD):`,
    ...orders.filter(o => o.shares > 0).map(o =>
      `- Buy ${o.shares} shares of ${o.etf.id} @ $${fmtNum(o.price, 2)} = $${fmtNum(o.cost, 2)} CAD`
    ),
    `Total Invested: $${fmtNum(totalInvested, 2)} CAD | Unused Cash: $${fmtNum(unusedCash, 2)} CAD`
  ].join("\n");

  resultsContainer.innerHTML = `
    <div class="allocator-summary-banner">
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Total to Deploy</span>
        <span class="allocator-stat-val">$${fmtNum(totalInvested, 2)}</span>
        <span class="allocator-stat-sub">${fmtNum((totalInvested / cash) * 100, 1)}% of $${fmtNum(cash, 0)}</span>
      </div>
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Unused Cash</span>
        <span class="allocator-stat-val">$${fmtNum(unusedCash, 2)}</span>
        <span class="allocator-stat-sub">Remainder unspent</span>
      </div>
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Look-Through FCF Yield</span>
        <span class="allocator-stat-val ${weightedFcf && weightedFcf >= 5 ? "fcf-highlight" : ""}">${weightedFcf ? `${fmtNum(weightedFcf, 2)}%` : "-"}</span>
        <span class="allocator-stat-sub">Cash generation of buy</span>
      </div>
      <div class="allocator-stat-item">
        <span class="allocator-stat-label">Valuation vs DCF</span>
        <span class="allocator-stat-val ${weightedPrem && weightedPrem < 0 ? "premium-discount" : "premium-expensive"}">${fmtPct(weightedPrem)}</span>
        <span class="allocator-stat-sub">Average look-through</span>
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
            <th>Value Rationale</th>
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
                <td><strong>$${fmtNum(o.price, 2)}</strong> <span class="muted">${escapeHtml(e.dec.currency)}</span></td>
                <td>${sharesHtml}</td>
                <td><strong>$${fmtNum(o.cost, 2)}</strong></td>
                <td>${fmtNum(pct, 1)}%</td>
                <td>
                  <span class="muted" style="font-size:0.8rem;">
                    $${fmtNum(e.data.intrinsic_per_dollar, 2)}/1 · ${typeof e.dec.fcfYield === "number" ? `${fmtNum(e.dec.fcfYield, 1)}% FCF` : ""}
                  </span>
                </td>
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
    const frac = (clampedX - m.left) / w;
    const idx = Math.max(0, Math.min(rows.length - 1, Math.round(frac * (rows.length - 1))));

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

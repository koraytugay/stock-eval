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
  const percentile = (premiums.filter(p => p <= current).length / premiums.length) * 100;
  return { current, percentile, min: Math.min(...premiums), max: Math.max(...premiums), median: median(premiums) };
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
  const etfRows = etfs.map(([id, data]) => ({
    id,
    data,
    stats: historyStats(etfHistoryRows(id)),
    catInfo: getEtfCategory(id)
  }));

  // 1. Total ETFs
  document.getElementById("kpi-etf-count").textContent = `${etfs.length} ETFs`;
  const avgCovered = etfs.reduce((s, [, d]) => s + (d.covered_weight_pct || 0), 0) / (etfs.length || 1);
  document.getElementById("kpi-etf-sub").textContent = `Avg ${fmtNum(avgCovered, 0)}% look-through valued`;

  // 2. Median Premium vs DCF
  const premiums = etfs.map(([, d]) => d.market_premium_pct).filter(p => typeof p === "number");
  const med = premiums.length ? median(premiums) : null;
  const medEl = document.getElementById("kpi-median-val");
  medEl.textContent = fmtPct(med);
  medEl.className = `kpi-value ${med !== null ? (med < 0 ? "premium-discount" : "premium-expensive") : ""}`;
  const discountsCount = premiums.filter(p => p < 0).length;
  document.getElementById("kpi-median-sub").textContent = `${discountsCount} of ${premiums.length} trade below intrinsic DCF`;

  // 3. Best Relative Value (Lowest percentile vs 1-year history)
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

  let list = Object.entries(currentSnapshot.etfs).map(([id, data]) => ({
    id,
    data,
    stats: historyStats(etfHistoryRows(id)),
    catInfo: getEtfCategory(id)
  }));

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
    if (sortBy === "percentile_asc") {
      const pA = a.stats ? a.stats.percentile : 999;
      const pB = b.stats ? b.stats.percentile : 999;
      return pA - pB;
    } else if (sortBy === "premium_asc") {
      return (a.data.market_premium_pct ?? 9999) - (b.data.market_premium_pct ?? 9999);
    } else if (sortBy === "intrinsic_desc") {
      return (b.data.intrinsic_per_dollar ?? -9999) - (a.data.intrinsic_per_dollar ?? -9999);
    } else if (sortBy === "premium_desc") {
      return (b.data.market_premium_pct ?? -9999) - (a.data.market_premium_pct ?? -9999);
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
    tbody.innerHTML = `<tr><td colspan="9" class="loading">No ETFs match the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(({ id, data, stats, catInfo }) => {
    const v = stats ? verdict(stats.percentile) : null;
    const premium = data.market_premium_pct;
    const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";
    const intrinsic = data.intrinsic_per_dollar !== undefined && data.intrinsic_per_dollar !== null
      ? `$${fmtNum(data.intrinsic_per_dollar, 4)}`
      : "-";

    return `
      <tr>
        <td>
          <strong>${escapeHtml(id)}</strong>
          <span class="status-note">${escapeHtml(data.name || "")}</span>
        </td>
        <td><span class="category-badge">${escapeHtml(catInfo.label)}</span></td>
        <td class="${premiumClass}"><strong>${fmtPct(premium)}</strong></td>
        <td>${intrinsic}</td>
        <td>${stats ? `${fmtPct(stats.min)} to ${fmtPct(stats.max)}` : "-"}</td>
        <td>${stats ? fmtPct(stats.median) : "-"}</td>
        <td><strong>${stats ? `${Math.round(stats.percentile)}th` : "-"}</strong></td>
        <td>${v ? `<span class="verdict ${v.cls}"><span aria-hidden="true">${v.icon}</span> ${v.label}</span>` : `<span class="muted">-</span>`}</td>
        <td>${fmtNum(data.covered_weight_pct, 1)}%</td>
      </tr>
    `;
  }).join("");
}

function renderEtfCards(list) {
  const container = document.getElementById("etf-cards-container");
  if (!list.length) {
    container.innerHTML = `<p class="placeholder-text">No ETFs match the selected search or filters.</p>`;
    return;
  }

  container.innerHTML = list.map(({ id, data, stats, catInfo }) => {
    const v = stats ? verdict(stats.percentile) : null;
    const premium = data.market_premium_pct;
    const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";
    const intrinsic = data.intrinsic_per_dollar !== undefined && data.intrinsic_per_dollar !== null
      ? `$${fmtNum(data.intrinsic_per_dollar, 4)}`
      : "N/A";

    return `
      <div class="etf-card">
        <div class="etf-card-header">
          <div>
            <div class="etf-card-title-row">
              <h3>${escapeHtml(data.name || id)}</h3>
              <span class="category-badge">${escapeHtml(catInfo.label)}</span>
            </div>
            <div class="etf-card-sub-row">
              <span class="etf-sym">${escapeHtml(id)}</span>
              <span class="badge etf-ccy">${escapeHtml(data.currency || "CAD")}</span>
            </div>
          </div>
          <span class="badge" title="Share of portfolio weight with a valid DCF valuation">${fmtNum(data.covered_weight_pct, 1)}% Valued</span>
        </div>

        <div class="etf-metrics-grid">
          <div class="etf-metric-box">
            <span class="metric-label">Market Premium vs DCF</span>
            <span class="metric-val ${premiumClass}">${fmtPct(premium)}</span>
          </div>
          <div class="etf-metric-box">
            <span class="metric-label">Intrinsic Value per $1</span>
            <span class="metric-val">${intrinsic}</span>
          </div>
          <div class="etf-metric-box">
            <span class="metric-label">Versus Past Year</span>
            <span class="metric-val">
              ${v ? `<span class="verdict ${v.cls}"><span aria-hidden="true">${v.icon}</span> ${v.label} (${Math.round(stats.percentile)}th %)</span>` : `<span class="muted">-</span>`}
            </span>
          </div>
          <div class="etf-metric-box">
            <span class="metric-label">Past-Year Range</span>
            <span class="metric-val-sub">
              ${stats ? `${fmtPct(stats.min)} to ${fmtPct(stats.max)} (med ${fmtPct(stats.median)})` : "-"}
            </span>
          </div>
        </div>

        ${typeof data.listed_weight_pct === "number" ? `
          <p class="muted etf-coverage">Published holdings cover ${fmtNum(data.listed_weight_pct, 1)}% of fund; ${fmtNum(data.covered_weight_pct, 1)}% has DCF valuation.</p>
        ` : ""}

        ${etfHistoryRows(id).length > 1 ? `
          <div class="etf-chart-block">
            <div class="etf-chart-title">Premium vs DCF, past year (lower = cheaper)</div>
            <div class="etf-chart" data-etf="${escapeHtml(id)}"></div>
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  drawEtfCharts();
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
  if (rows.length < 2) return;
  const width = container.clientWidth || 360;
  const height = 170;
  const m = { top: 10, right: 12, bottom: 22, left: 46 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;

  const times = rows.map(r => Date.parse(r[0]));
  const values = rows.map(r => r[2]);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const pad = (Math.max(vMax, 0) - Math.min(vMin, 0)) * 0.08 || 5;
  let lo = vMin < 0 ? vMin - pad : 0;
  let hi = vMax > 0 ? vMax + pad : 0;
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

  const t0 = times[0], t1 = times[times.length - 1];
  const x = t => m.left + ((t - t0) / (t1 - t0)) * w;
  const y = v => m.top + (1 - (v - lo) / (hi - lo)) * h;

  const svg = svgEl("svg", { width, height, role: "img", "aria-label": "Premium versus DCF over the past year" });

  const backfilledUntil = etfHistory && etfHistory.backfilled_until;
  if (backfilledUntil) {
    const bx = x(Math.min(Date.parse(backfilledUntil), t1));
    svg.appendChild(svgEl("rect", { x: m.left, y: m.top, width: Math.max(bx - m.left, 0), height: h, class: "chart-backfill" }));
  }

  // Gridlines and y ticks
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.appendChild(svgEl("line", { x1: m.left, x2: m.left + w, y1: y(v), y2: y(v), class: v === 0 ? "chart-zero" : "chart-grid" }));
    const label = svgEl("text", { x: m.left - 6, y: y(v) + 3, "text-anchor": "end", class: "chart-tick" });
    label.textContent = `${v > 0 ? "+" : ""}${Math.round(v)}%`;
    svg.appendChild(label);
  }

  // Month ticks
  const d = new Date(t0);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  let monthIdx = 0;
  while (d.getTime() <= t1) {
    if (monthIdx % 3 === 0) {
      const tx = x(d.getTime());
      const label = svgEl("text", { x: tx, y: height - 6, "text-anchor": "middle", class: "chart-tick" });
      label.textContent = d.toLocaleDateString("en-CA", { month: "short", year: "2-digit", timeZone: "UTC" });
      svg.appendChild(label);
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
    monthIdx++;
  }

  const points = rows.map((r, i) => [x(times[i]), y(values[i])]);
  const linePath = points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const base = y(Math.max(lo, Math.min(0, hi)));
  svg.appendChild(svgEl("path", { d: `${linePath}L${points[points.length - 1][0]},${base}L${points[0][0]},${base}Z`, class: "chart-area" }));
  svg.appendChild(svgEl("path", { d: linePath, class: "chart-line" }));

  // End dot
  const last = points[points.length - 1];
  svg.appendChild(svgEl("circle", { cx: last[0], cy: last[1], r: 4, class: "chart-dot" }));

  // Crosshair + tooltip
  const cross = svgEl("line", { y1: m.top, y2: m.top + h, class: "chart-cross", visibility: "hidden" });
  const hoverDot = svgEl("circle", { r: 4, class: "chart-dot", visibility: "hidden" });
  svg.appendChild(cross);
  svg.appendChild(hoverDot);
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  tip.hidden = true;
  const tipValue = document.createElement("strong");
  const tipDetail = document.createElement("span");
  tip.append(tipValue, tipDetail);

  const hit = svgEl("rect", { x: m.left, y: m.top, width: w, height: h, fill: "transparent" });
  const show = evt => {
    const rect = svg.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const t = t0 + ((px - m.left) / w) * (t1 - t0);
    let i = 0;
    for (let j = 1; j < times.length; j++) if (Math.abs(times[j] - t) < Math.abs(times[i] - t)) i = j;
    const [cx, cy] = points[i];
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", cx); hoverDot.setAttribute("cy", cy); hoverDot.setAttribute("visibility", "visible");
    tipValue.textContent = fmtPct(values[i]);
    const reconstructed = backfilledUntil && rows[i][0] <= backfilledUntil ? " (reconstructed)" : "";
    tipDetail.textContent = `${rows[i][0]} \u00b7 $${fmtNum(rows[i][1])} per $1${reconstructed}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(cx - 70, 0), width - 150)}px`;
    tip.style.top = `${Math.max(cy - 52, 0)}px`;
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerleave", hide);
  svg.appendChild(hit);

  container.append(svg, tip);
}

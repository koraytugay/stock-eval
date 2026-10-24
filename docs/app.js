// StockEval Dashboard Frontend Engine

let currentSnapshot = null;
let allHistoryDates = [];
let expandedTicker = null;

// The dashboard lives in docs/ and reads data/ from the repo root; "data/" is kept as a fallback for other layouts.
const DATA_ROOTS = ["../data/", "data/"];
let dataRoot = null;

const STATUS_LABELS = {
  ok: "Valued",
  no_fundamentals: "No fundamentals",
  no_shares: "Share count missing",
  negative_fcf: "Negative FCF",
  no_fx_rate: "FX rate unavailable",
  no_price: "No price",
  sector_excluded: "Sector excluded (FCFF N/A)",
  debt_exceeds_value: "Debt exceeds value",
  model_not_applicable: "Model not applicable"
};

const STATUS_EXPLANATIONS = {
  no_fundamentals: "No usable cash flow data was found in SEC filings or Yahoo Finance.",
  no_shares: "The share count could not be determined, so a per-share value cannot be computed.",
  negative_fcf: "Average free cash flow over recent years is zero or negative, so a cash-flow DCF gives no meaningful value.",
  no_fx_rate: "The exchange rate between the reporting and listing currency was unavailable.",
  sector_excluded: "Free cash flow to the firm is not a meaningful measure for banks and insurers, so this sector is not valued.",
  debt_exceeds_value: "Net debt is larger than the modelled value of the whole business, so nothing is left for shareholders and the equity value is shown as zero.",
  model_not_applicable: "The discount rate is not above terminal growth, so the model cannot produce a value."
};

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupEventListeners();
  await loadHistoryIndex();
  await loadSnapshot("latest");
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

function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      const targetId = tab.getAttribute("data-tab");
      document.getElementById(targetId).classList.add("active");
    });
  });
}

function setupEventListeners() {
  document.getElementById("search-input").addEventListener("input", renderStocksTable);
  document.getElementById("filter-index").addEventListener("change", renderStocksTable);
  document.getElementById("filter-sector").addEventListener("change", renderStocksTable);
  document.getElementById("valued-only").addEventListener("change", renderStocksTable);
  document.querySelector("#stocks-table tbody").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-ticker]");
    if (!row) return;
    expandedTicker = expandedTicker === row.dataset.ticker ? null : row.dataset.ticker;
    renderStocksTable();
  });
  document.getElementById("sort-by").addEventListener("change", renderStocksTable);
  document.getElementById("snapshot-select").addEventListener("change", (e) => {
    loadSnapshot(e.target.value);
  });
  document.getElementById("run-backtest-btn").addEventListener("click", runBacktest);
}

async function loadHistoryIndex() {
  try {
    allHistoryDates = await fetchData("history_index.json");
    const options = allHistoryDates.slice().reverse()
      .map(date => `<option value="${escapeHtml(date)}">${escapeHtml(date)}</option>`).join("");
    document.getElementById("snapshot-select").innerHTML = `<option value="latest">Latest Snapshot</option>${options}`;

    // Populate backtest selectors
    const last = allHistoryDates.length - 1;
    document.getElementById("backtest-base-date").innerHTML = allHistoryDates
      .map((d, idx) => `<option value="${escapeHtml(d)}" ${idx === 0 ? "selected" : ""}>${escapeHtml(d)}</option>`).join("");
    document.getElementById("backtest-target-date").innerHTML = allHistoryDates
      .map((d, idx) => `<option value="${escapeHtml(d)}" ${idx === last ? "selected" : ""}>${escapeHtml(d)}</option>`).join("");
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
    populateSectorFilter();
    renderStocksTable();
    renderETFs();
  } catch (err) {
    console.error("Failed to load snapshot:", err);
    document.getElementById("last-updated").textContent = "Error loading snapshot";
    document.querySelector("#stocks-table tbody").innerHTML =
      `<tr><td colspan="10" class="loading">Could not load snapshot data.</td></tr>`;
  }
}

function populateSectorFilter() {
  const select = document.getElementById("filter-sector");
  const current = select.value;
  const sectors = [...new Set(Object.values(currentSnapshot.stocks).map(s => s.sector).filter(Boolean))].sort();
  select.innerHTML = `<option value="ALL">All Sectors</option>` +
    sectors.map(sec => `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`).join("");
  if (sectors.includes(current)) select.value = current;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isValued(s) {
  return s.valuation && typeof s.valuation.market_premium_pct === "number";
}

function impliedGrowthText(val) {
  if (typeof val.implied_growth_reverse_dcf === "number") return `${(val.implied_growth_reverse_dcf * 100).toFixed(1)}%`;
  if (val.implied_growth_status === "above_range") return "&gt;150%";
  if (val.implied_growth_status === "below_range") return "&lt;-50%";
  return "N/A";
}

function updateKPIs() {
  if (!currentSnapshot || !currentSnapshot.stocks) return;
  const stocks = Object.values(currentSnapshot.stocks);
  const valued = stocks.filter(isValued);

  document.getElementById("kpi-stocks-count").textContent = stocks.length;
  document.getElementById("kpi-stocks-sub").textContent = `${valued.length} with a DCF valuation`;
  const medianPremium = valued.length ? median(valued.map(s => s.valuation.market_premium_pct)) : null;
  document.getElementById("kpi-median-val").textContent = fmtPct(medianPremium);
  document.getElementById("kpi-median-sub").textContent = valued.length
    ? `${valued.filter(s => s.valuation.market_premium_pct < 0).length} trade below their DCF value`
    : "Across valued equities";

  const setKpi = (tickerId, valId, ticker, text) => {
    document.getElementById(tickerId).textContent = ticker;
    document.getElementById(valId).textContent = text;
  };
  setKpi("kpi-cheapest-ticker", "kpi-cheapest-val", "-", "-");
  setKpi("kpi-growth-ticker", "kpi-growth-val", "-", "-");

  if (valued.length > 0) {
    const cheapest = valued.reduce((a, b) => (b.valuation.market_premium_pct < a.valuation.market_premium_pct ? b : a));
    setKpi("kpi-cheapest-ticker", "kpi-cheapest-val", cheapest.ticker, `${fmtPct(cheapest.valuation.market_premium_pct)} vs DCF`);

    const withGrowth = valued.filter(s => typeof s.valuation.implied_growth_reverse_dcf === "number");
    if (withGrowth.length > 0) {
      const top = withGrowth.reduce((a, b) => (b.valuation.implied_growth_reverse_dcf > a.valuation.implied_growth_reverse_dcf ? b : a));
      setKpi("kpi-growth-ticker", "kpi-growth-val", top.ticker, `${(top.valuation.implied_growth_reverse_dcf * 100).toFixed(1)}% / yr implied`);
    }
  }
}

function renderStocksTable() {
  if (!currentSnapshot || !currentSnapshot.stocks) return;
  const tbody = document.querySelector("#stocks-table tbody");
  const searchQuery = document.getElementById("search-input").value.trim().toUpperCase();
  const filterIndex = document.getElementById("filter-index").value;
  const filterSector = document.getElementById("filter-sector").value;
  const valuedOnly = document.getElementById("valued-only").checked;
  const sortBy = document.getElementById("sort-by").value;

  let list = Object.values(currentSnapshot.stocks);

  // Search filter
  if (searchQuery) {
    list = list.filter(s => s.ticker.includes(searchQuery)
      || (s.indices && s.indices.join(" ").includes(searchQuery))
      || (s.sector && s.sector.toUpperCase().includes(searchQuery)));
  }

  // Index, sector and valuation filters
  if (filterIndex === "MYETFS") {
    const held = new Set(Object.values(currentSnapshot.etfs || {}).flatMap(e => (e.holdings || []).map(h => h.ticker)));
    list = list.filter(s => held.has(s.ticker));
  } else if (filterIndex !== "ALL") {
    list = list.filter(s => s.indices && s.indices.includes(filterIndex));
  }
  if (filterSector !== "ALL") {
    list = list.filter(s => s.sector === filterSector);
  }
  if (valuedOnly) {
    list = list.filter(isValued);
  }
  const total = Object.keys(currentSnapshot.stocks).length;
  document.getElementById("result-count").textContent = `Showing ${list.length} of ${total} equities.`;

  // Sort
  list.sort((a, b) => {
    const valA = a.valuation || {};
    const valB = b.valuation || {};
    if (sortBy === "premium_asc") {
      return (valA.market_premium_pct ?? 9999) - (valB.market_premium_pct ?? 9999);
    } else if (sortBy === "premium_desc") {
      return (valB.market_premium_pct ?? -9999) - (valA.market_premium_pct ?? -9999);
    } else if (sortBy === "growth_desc") {
      return (valB.implied_growth_reverse_dcf ?? -9999) - (valA.implied_growth_reverse_dcf ?? -9999);
    } else if (sortBy === "price_desc") {
      return b.market_price - a.market_price;
    } else if (sortBy === "ticker_asc") {
      return a.ticker.localeCompare(b.ticker);
    }
    return 0;
  });

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading">No equities match the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => {
    const val = s.valuation || {};
    const raw = s.raw || {};
    const premium = val.market_premium_pct;
    const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";
    const status = s.valuation_status || (s.valuation ? "ok" : "no_fundamentals");
    const statusNote = status === "ok" ? "" : `<span class="status-note">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
    const assumptions = typeof val.growth_rate_assumed === "number"
      ? `${(val.growth_rate_assumed * 100).toFixed(1)}% / ${(val.wacc * 100).toFixed(1)}%`
      : "-";
    const fundCcy = raw.currency && raw.currency !== s.currency ? ` ${escapeHtml(raw.currency)}` : "";
    const basis = raw.fcf_basis ? ` <span class="muted">${escapeHtml(raw.fcf_basis)}</span>` : "";

    const expanded = expandedTicker === s.ticker;
    return `
      <tr data-ticker="${escapeHtml(s.ticker)}" class="stock-row${expanded ? " expanded" : ""}">
        <td><strong>${escapeHtml(s.ticker)}</strong>${s.sector ? `<span class="status-note">${escapeHtml(s.sector)}</span>` : ""}</td>
        <td>${escapeHtml((s.indices || []).join(", ")) || "-"}</td>
        <td>${escapeHtml(s.currency || "USD")}</td>
        <td>${fmtNum(s.market_price)}</td>
        <td>${fmtNum(val.intrinsic_dcf)}${statusNote}</td>
        <td class="${premiumClass}">${fmtPct(premium)}</td>
        <td>${impliedGrowthText(val)}</td>
        <td title="${val.growth_source === "historical" ? "Growth from historical FCF CAGR" : "Default growth"}">${assumptions}</td>
        <td>${fmtNum(raw.free_cash_flow)}${fundCcy}${basis}</td>
        <td>${fmtNum(raw.net_debt)}${fundCcy}</td>
      </tr>
      ${expanded ? `<tr class="detail-row"><td colspan="10">${stockDetailHtml(s)}</td></tr>` : ""}
    `;
  }).join("");
}

function stockDetailHtml(s) {
  const val = s.valuation || {};
  const raw = s.raw || {};
  const model = currentSnapshot.model || {};
  const status = s.valuation_status || (s.valuation ? "ok" : "no_fundamentals");
  const ccy = escapeHtml(raw.currency || s.currency || "");
  const money = n => (typeof n === "number" ? `${fmtNum(n)}B ${ccy}` : "-");
  const pct = n => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "-");
  const item = (label, value) => `<div class="detail-item"><span class="detail-label">${label}</span><span>${value}</span></div>`;

  const history = (raw.fcf_history || []).slice(-6)
    .map(([end, v]) => `<span class="history-chip">${escapeHtml(end.slice(0, 4))}: ${fmtNum(v)}</span>`).join("");
  const warnings = (raw.warnings || []).map(w => escapeHtml(w.replace(/_/g, " "))).join(", ");
  const explanation = STATUS_EXPLANATIONS[status];

  return `
    <div class="stock-detail">
      ${explanation ? `<p class="detail-explanation">${escapeHtml(explanation)}</p>` : ""}
      <div class="detail-grid">
        ${item("Data source", escapeHtml(raw.source || "-"))}
        ${item("Cash flow period", `${escapeHtml(raw.fcf_basis || "-")} to ${escapeHtml(raw.fcf_period_end || "-")}`)}
        ${item("Filed / fetched", `${escapeHtml(raw.filed || "-")} / ${escapeHtml(raw.fetched_at || "-")}`)}
        ${item("Operating cash flow", money(raw.operating_cash_flow))}
        ${item("Capital expenditure", money(raw.capex))}
        ${item("Free cash flow (latest)", money(raw.free_cash_flow))}
        ${item("FCF used in DCF (avg)", money(val.fcf_used))}
        ${item("Cash", money(raw.total_cash))}
        ${item("Debt", money(raw.total_debt))}
        ${item("Net debt", money(raw.net_debt))}
        ${item("Shares outstanding", typeof raw.shares_outstanding === "number" ? `${fmtNum(raw.shares_outstanding, 3)}B` : "-")}
        ${item("Enterprise value (DCF)", money(val.enterprise_value))}
        ${item("Forecast growth", `${pct(val.growth_rate_assumed)}${val.growth_source ? ` (${escapeHtml(val.growth_source)})` : ""}`)}
        ${item("Discount rate (WACC)", pct(val.wacc))}
        ${item("Terminal growth", pct(model.terminal_growth))}
        ${item("FX rate to listing currency", typeof val.fx_rate === "number" && val.fx_rate !== 1 ? fmtNum(val.fx_rate, 4) : "-")}
        ${val.adr_ratio ? item("Shares per ADR (inferred)", fmtNum(val.adr_ratio, 2)) : ""}
      </div>
      ${history ? `<div class="detail-history"><span class="detail-label">Annual FCF history (B ${ccy})</span>${history}</div>` : ""}
      ${warnings ? `<p class="muted">Data gaps: ${warnings}</p>` : ""}
    </div>
  `;
}

function renderETFs() {
  if (!currentSnapshot || !currentSnapshot.etfs) return;
  const container = document.getElementById("etf-cards-container");
  const etfs = Object.entries(currentSnapshot.etfs);

  if (etfs.length === 0) {
    container.innerHTML = `<p class="placeholder-text">No custom ETFs found. Define them in <code>config/custom_etfs.json</code>.</p>`;
    return;
  }

  container.innerHTML = etfs.map(([etfId, data]) => {
    const holdings = (data.holdings || []).slice().sort((a, b) => b.weight - a.weight);
    const holdingRow = h => {
      const stock = (currentSnapshot.stocks || {})[h.ticker] || {};
      const val = stock.valuation || {};
      const status = !stock.ticker ? "no_price" : stock.valuation_status || (stock.valuation ? "ok" : "no_fundamentals");
      const premium = val.market_premium_pct;
      const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";
      return `
        <tr>
          <td><strong>${escapeHtml(h.ticker)}</strong>${h.name ? `<span class="status-note">${escapeHtml(h.name)}</span>` : ""}</td>
          <td>${fmtNum(h.weight * 100, 2)}%</td>
          <td>${fmtNum(stock.market_price)} ${escapeHtml(stock.currency || "")}</td>
          <td>${status === "ok" ? fmtNum(val.intrinsic_dcf) : `<span class="muted">${escapeHtml(STATUS_LABELS[status] || status)}</span>`}</td>
          <td class="${premiumClass}">${fmtPct(premium)}</td>
        </tr>
      `;
    };
    const VISIBLE = 15;
    const holdingsTable = rows => `
      <table class="etf-holdings-table">
        <thead><tr><th>Holding</th><th>Fund Weight</th><th>Price</th><th>DCF</th><th>Premium</th></tr></thead>
        <tbody>${rows.map(holdingRow).join("")}</tbody>
      </table>`;
    const rest = holdings.slice(VISIBLE);
    const coverage = typeof data.listed_weight_pct === "number"
      ? `<p class="muted etf-coverage">Published holdings cover ${fmtNum(data.listed_weight_pct, 1)}% of the fund;
         ${fmtNum(data.covered_weight_pct, 1)}% has a DCF valuation and drives the figures above.</p>`
      : "";

    // Snapshots written before the look-through rework only have weighted per-share sums
    const summary = data.intrinsic_per_dollar !== undefined
      ? `<p><strong>Intrinsic value per $1 invested:</strong> ${data.intrinsic_per_dollar === null ? "N/A" : `$${fmtNum(data.intrinsic_per_dollar)}`}</p>
         <p><strong>Market premium vs DCF:</strong> <span class="${data.market_premium_pct < 0 ? "premium-discount" : "premium-expensive"}">${fmtPct(data.market_premium_pct)}</span></p>`
      : `<p class="muted">Legacy snapshot: weighted price ${fmtNum(data.weighted_market_price)}, weighted DCF ${fmtNum(data.weighted_intrinsic_dcf)}</p>`;

    return `
      <div class="etf-card">
        <div class="etf-card-header">
          <div>
            <h3>${escapeHtml(data.name || etfId)}</h3>
            <span class="etf-sym">${escapeHtml(etfId)}</span>
          </div>
          <span class="badge" title="Share of portfolio weight with a valid DCF valuation">${escapeHtml(data.covered_weight_pct)}% Valued</span>
        </div>
        ${summary}
        ${coverage}
        ${holdingsTable(holdings.slice(0, VISIBLE))}
        ${rest.length ? `<details class="etf-more"><summary>Show ${rest.length} more holdings</summary>${holdingsTable(rest)}</details>` : ""}
      </div>
    `;
  }).join("");
}

function knownBy(stock, date) {
  // Exclude valuations built from data that was filed or fetched after the base date (look-ahead bias)
  const raw = stock.raw || {};
  return (!raw.filed || raw.filed <= date) && (!raw.fetched_at || raw.fetched_at <= date);
}

async function runBacktest() {
  const baseDate = document.getElementById("backtest-base-date").value;
  const targetDate = document.getElementById("backtest-target-date").value;
  const size = parseInt(document.getElementById("backtest-size").value, 10);
  const resultsDiv = document.getElementById("backtest-results");

  if (!baseDate || !targetDate || baseDate >= targetDate) {
    resultsDiv.innerHTML = `<p class="placeholder-text">Please select a base date earlier than the evaluation date.</p>`;
    return;
  }

  resultsDiv.innerHTML = `<p class="placeholder-text">Computing historical performance...</p>`;

  try {
    const [baseData, targetData] = await Promise.all([
      fetchData(`snapshots/${baseDate}.json`),
      fetchData(`snapshots/${targetDate}.json`)
    ]);

    const baseStocks = baseData.stocks || {};
    const targetStocks = targetData.stocks || {};
    const returnOf = s => ((targetStocks[s.ticker].market_price - s.market_price) / s.market_price) * 100;
    const avg = list => (list.length ? list.reduce((sum, s) => sum + returnOf(s), 0) / list.length : null);

    const candidates = Object.values(baseStocks).filter(s => isValued(s) && targetStocks[s.ticker]?.market_price);
    const eligible = candidates.filter(s => knownBy(s, baseDate))
      .sort((a, b) => a.valuation.market_premium_pct - b.valuation.market_premium_pct);
    const excluded = candidates.length - eligible.length;

    if (eligible.length < size * 2) {
      resultsDiv.innerHTML = `<p class="placeholder-text">Only ${eligible.length} stocks have valuations on both dates; pick a smaller basket.</p>`;
      return;
    }

    const cheapest = eligible.slice(0, size);
    const priciest = eligible.slice(-size).reverse();
    const cheapAvg = avg(cheapest), priceyAvg = avg(priciest), marketAvg = avg(eligible);
    const cls = n => (n >= 0 ? "premium-discount" : "premium-expensive");

    const row = s => {
      const ret = returnOf(s);
      return `
        <tr>
          <td><strong>${escapeHtml(s.ticker)}</strong></td>
          <td>${fmtPct(s.valuation.market_premium_pct)}</td>
          <td>${fmtNum(s.market_price)}</td>
          <td>${fmtNum(targetStocks[s.ticker].market_price)}</td>
          <td class="${cls(ret)}">${fmtPct(ret, 2)}</td>
        </tr>
      `;
    };
    const basketTable = (title, list) => `
      <div class="backtest-basket">
        <h4>${title}</h4>
        <table>
          <thead><tr><th>Ticker</th><th>Premium</th><th>${escapeHtml(baseDate)}</th><th>${escapeHtml(targetDate)}</th><th>Return</th></tr></thead>
          <tbody>${list.map(row).join("")}</tbody>
        </table>
      </div>
    `;

    resultsDiv.innerHTML = `
      <h3>${escapeHtml(baseDate)} &rarr; ${escapeHtml(targetDate)}</h3>
      <div class="kpi-grid">
        <div class="kpi-card"><h3>${size} Cheapest</h3><p class="kpi-value ${cls(cheapAvg)}">${fmtPct(cheapAvg, 2)}</p><span class="kpi-sub">average price return</span></div>
        <div class="kpi-card"><h3>All Valued (${eligible.length})</h3><p class="kpi-value ${cls(marketAvg)}">${fmtPct(marketAvg, 2)}</p><span class="kpi-sub">equal-weight benchmark</span></div>
        <div class="kpi-card"><h3>${size} Most Expensive</h3><p class="kpi-value ${cls(priceyAvg)}">${fmtPct(priceyAvg, 2)}</p><span class="kpi-sub">average price return</span></div>
      </div>
      <p class="muted backtest-note">
        Cheapest minus benchmark: <strong class="${cls(cheapAvg - marketAvg)}">${fmtPct(cheapAvg - marketAvg, 2)}</strong>.
        Price returns only (dividends excluded).
        ${excluded > 0 ? ` ${excluded} stocks excluded because their fundamentals were filed or fetched after ${escapeHtml(baseDate)}.` : ""}
      </p>
      <div class="backtest-baskets">
        ${basketTable(`${size} Cheapest`, cheapest)}
        ${basketTable(`${size} Most Expensive`, priciest)}
      </div>
    `;
  } catch (err) {
    resultsDiv.innerHTML = `<p class="placeholder-text">Error running backtest: ${escapeHtml(err.message)}</p>`;
  }
}

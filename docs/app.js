// StockEval Dashboard Frontend Engine

let currentSnapshot = null;
let allHistoryDates = [];

// The dashboard lives in docs/ and reads data/ from the repo root; "data/" is kept as a fallback for other layouts.
const DATA_ROOTS = ["../data/", "data/"];
let dataRoot = null;

const STATUS_LABELS = {
  ok: "Valued",
  no_fundamentals: "No fundamentals",
  no_shares: "Share count missing",
  negative_fcf: "Negative FCF",
  no_fx_rate: "FX rate unavailable",
  sector_excluded: "Sector excluded (FCFF N/A)",
  model_not_applicable: "Model not applicable"
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
    renderStocksTable();
    renderETFs();
  } catch (err) {
    console.error("Failed to load snapshot:", err);
    document.getElementById("last-updated").textContent = "Error loading snapshot";
    document.querySelector("#stocks-table tbody").innerHTML =
      `<tr><td colspan="10" class="loading">Could not load snapshot data.</td></tr>`;
  }
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
  const etfs = Object.values(currentSnapshot.etfs || {});
  const valued = stocks.filter(isValued);

  document.getElementById("kpi-stocks-count").textContent = stocks.length;
  document.getElementById("kpi-stocks-sub").textContent = `${valued.length} with a DCF valuation`;
  document.getElementById("kpi-etf-count").textContent = etfs.length;

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
  const sortBy = document.getElementById("sort-by").value;

  let list = Object.values(currentSnapshot.stocks);

  // Search filter
  if (searchQuery) {
    list = list.filter(s => s.ticker.includes(searchQuery)
      || (s.indices && s.indices.join(" ").includes(searchQuery))
      || (s.sector && s.sector.toUpperCase().includes(searchQuery)));
  }

  // Index filter
  if (filterIndex !== "ALL") {
    list = list.filter(s => s.indices && s.indices.includes(filterIndex));
  }

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

    return `
      <tr>
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
    `;
  }).join("");
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
    const holdings = data.holdings || [];
    const holdingsRows = holdings.map(h => {
      const stock = (currentSnapshot.stocks || {})[h.ticker] || {};
      const val = stock.valuation || {};
      const status = stock.valuation_status || (stock.valuation ? "ok" : "no_fundamentals");
      const premium = val.market_premium_pct;
      const premiumClass = typeof premium === "number" ? (premium < 0 ? "premium-discount" : "premium-expensive") : "muted";
      return `
        <tr>
          <td><strong>${escapeHtml(h.ticker)}</strong></td>
          <td>${fmtNum(h.weight * 100, 1)}%</td>
          <td>${fmtNum(stock.market_price)} ${escapeHtml(stock.currency || "")}</td>
          <td>${status === "ok" ? fmtNum(val.intrinsic_dcf) : `<span class="muted">${escapeHtml(STATUS_LABELS[status] || status)}</span>`}</td>
          <td class="${premiumClass}">${fmtPct(premium)}</td>
        </tr>
      `;
    }).join("");

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

        <table class="etf-holdings-table">
          <thead>
            <tr>
              <th>Holding</th>
              <th>Weight</th>
              <th>Price</th>
              <th>DCF</th>
              <th>Premium</th>
            </tr>
          </thead>
          <tbody>
            ${holdingsRows}
          </tbody>
        </table>
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

    const candidates = Object.values(baseStocks).filter(s => isValued(s) && targetStocks[s.ticker]);
    const eligible = candidates.filter(s => knownBy(s, baseDate));
    const excluded = candidates.length - eligible.length;

    // Rank base stocks by cheapest valuation
    const top5Cheapest = eligible
      .sort((a, b) => a.valuation.market_premium_pct - b.valuation.market_premium_pct)
      .slice(0, 5);

    let totalReturn = 0;
    const rows = top5Cheapest.map(s => {
      const p1 = s.market_price;
      const p2 = targetStocks[s.ticker].market_price;
      const ret = ((p2 - p1) / p1) * 100;
      totalReturn += ret;
      return `
        <tr>
          <td><strong>${escapeHtml(s.ticker)}</strong></td>
          <td>${fmtNum(p1)}</td>
          <td>${fmtNum(p2)}</td>
          <td>${fmtNum(s.valuation.intrinsic_dcf)}</td>
          <td class="${ret >= 0 ? "premium-discount" : "premium-expensive"}">${fmtPct(ret, 2)}</td>
        </tr>
      `;
    }).join("");

    const avgReturn = top5Cheapest.length > 0 ? totalReturn / top5Cheapest.length : 0;
    resultsDiv.innerHTML = `
      <h3>Backtest: Top 5 Undervalued Stocks from ${escapeHtml(baseDate)} to ${escapeHtml(targetDate)}</h3>
      ${excluded > 0 ? `<p class="muted">${excluded} stocks excluded: their fundamentals were filed or fetched after ${escapeHtml(baseDate)}.</p>` : ""}
      <table style="width: 100%; margin-top: 1rem;">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Base Price (${escapeHtml(baseDate)})</th>
            <th>Subsequent Price (${escapeHtml(targetDate)})</th>
            <th>Base DCF Value</th>
            <th>Return (%)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top: 1rem; font-weight: 600;">
        Average Basket Return: <span class="${avgReturn >= 0 ? "premium-discount" : "premium-expensive"}">${fmtPct(avgReturn, 2)}</span>
      </div>
    `;
  } catch (err) {
    resultsDiv.innerHTML = `<p class="placeholder-text">Error running backtest: ${escapeHtml(err.message)}</p>`;
  }
}

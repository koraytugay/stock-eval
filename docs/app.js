// StockEval Dashboard Frontend Engine

let currentSnapshot = null;
let allHistoryDates = [];

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupEventListeners();
  await loadHistoryIndex();
  await loadSnapshot("latest");
});

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
    const res = await fetch("../data/history_index.json");
    if (res.ok) {
      allHistoryDates = await res.json();
      const select = document.getElementById("snapshot-select");
      select.innerHTML = `<option value="latest">Latest Snapshot</option>`;
      allHistoryDates.slice().reverse().forEach(date => {
        select.innerHTML += `<option value="${date}">${date}</option>`;
      });

      // Populate backtest selectors
      const baseSelect = document.getElementById("backtest-base-date");
      const targetSelect = document.getElementById("backtest-target-date");
      baseSelect.innerHTML = "";
      targetSelect.innerHTML = "";
      allHistoryDates.forEach((d, idx) => {
        baseSelect.innerHTML += `<option value="${d}" ${idx === 0 ? "selected" : ""}>${d}</option>`;
        targetSelect.innerHTML += `<option value="${d}" ${idx === allHistoryDates.length - 1 ? "selected" : ""}>${d}</option>`;
      });
    }
  } catch (err) {
    console.warn("Could not load history index, fallback to latest:", err);
  }
}

async function loadSnapshot(dateOrLatest) {
  const path = dateOrLatest === "latest" ? "../data/latest.json" : `../data/snapshots/${dateOrLatest}.json`;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error("Snapshot not found");
    currentSnapshot = await res.json();
    document.getElementById("last-updated").textContent = `Snapshot: ${currentSnapshot.date || dateOrLatest}`;
    updateKPIs();
    renderStocksTable();
    renderETFs();
  } catch (err) {
    console.error("Failed to load snapshot:", err);
    document.getElementById("last-updated").textContent = "Error loading snapshot";
  }
}

function updateKPIs() {
  if (!currentSnapshot || !currentSnapshot.stocks) return;
  const stocks = Object.values(currentSnapshot.stocks);
  const etfs = Object.values(currentSnapshot.etfs || {});

  document.getElementById("kpi-stocks-count").textContent = stocks.length;
  document.getElementById("kpi-etf-count").textContent = etfs.length;

  // Filter stocks with valid valuations
  const valued = stocks.filter(s => s.valuation && s.valuation.market_premium_pct !== null);
  if (valued.length > 0) {
    const sortedByDiscount = valued.slice().sort((a, b) => a.valuation.market_premium_pct - b.valuation.market_premium_pct);
    const cheapest = sortedByDiscount[0];
    document.getElementById("kpi-cheapest-ticker").textContent = cheapest.ticker;
    document.getElementById("kpi-cheapest-val").textContent = `${cheapest.valuation.market_premium_pct > 0 ? "+" : ""}${cheapest.valuation.market_premium_pct}% vs DCF`;

    const sortedByGrowth = valued.filter(s => s.valuation.implied_growth_reverse_dcf !== null)
      .sort((a, b) => b.valuation.implied_growth_reverse_dcf - a.valuation.implied_growth_reverse_dcf);
    if (sortedByGrowth.length > 0) {
      const topGrowth = sortedByGrowth[0];
      document.getElementById("kpi-growth-ticker").textContent = topGrowth.ticker;
      document.getElementById("kpi-growth-val").textContent = `${(topGrowth.valuation.implied_growth_reverse_dcf * 100).toFixed(1)}% / yr implied`;
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
    list = list.filter(s => s.ticker.includes(searchQuery) || (s.indices && s.indices.join(" ").includes(searchQuery)));
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
    tbody.innerHTML = `<tr><td colspan="9" class="loading">No equities match the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => {
    const val = s.valuation || {};
    const raw = s.raw || {};
    const premium = val.market_premium_pct;
    const premiumClass = premium !== undefined && premium < 0 ? "premium-discount" : "premium-expensive";
    const premiumText = premium !== undefined && premium !== null ? `${premium > 0 ? "+" : ""}${premium.toFixed(1)}%` : "N/A";
    const growthText = val.implied_growth_reverse_dcf !== undefined && val.implied_growth_reverse_dcf !== null ? `${(val.implied_growth_reverse_dcf * 100).toFixed(1)}%` : "N/A";

    return `
      <tr>
        <td><strong>${s.ticker}</strong></td>
        <td>${(s.indices || []).join(", ") || "-"}</td>
        <td>${s.currency || "USD"}</td>
        <td>$${s.market_price ? s.market_price.toFixed(2) : "-"}</td>
        <td>$${val.intrinsic_dcf !== undefined ? val.intrinsic_dcf.toFixed(2) : "-"}</td>
        <td class="${premiumClass}">${premiumText}</td>
        <td>${growthText}</td>
        <td>${raw.free_cash_flow !== undefined ? `$${raw.free_cash_flow.toFixed(2)}` : "-"}</td>
        <td>${raw.net_debt !== undefined ? `$${raw.net_debt.toFixed(2)}` : "-"}</td>
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
      const price = stock.market_price ? `$${stock.market_price.toFixed(2)}` : "-";
      const intrin = stock.valuation && stock.valuation.intrinsic_dcf !== undefined ? `$${stock.valuation.intrinsic_dcf.toFixed(2)}` : "-";
      return `
        <tr>
          <td><strong>${h.ticker}</strong></td>
          <td>${(h.weight * 100).toFixed(1)}%</td>
          <td>${price}</td>
          <td>${intrin}</td>
        </tr>
      `;
    }).join("");

    return `
      <div class="etf-card">
        <div class="etf-card-header">
          <div>
            <h3>${data.name || etfId}</h3>
            <span class="etf-sym">${etfId}</span>
          </div>
          <span class="badge">${data.covered_weight_pct}% Covered</span>
        </div>
        <p><strong>Weighted Market Price:</strong> $${data.weighted_market_price} ${data.currency}</p>
        <p><strong>Weighted Intrinsic DCF:</strong> $${data.weighted_intrinsic_dcf} ${data.currency}</p>
        
        <table class="etf-holdings-table">
          <thead>
            <tr>
              <th>Holding</th>
              <th>Weight</th>
              <th>Price</th>
              <th>DCF</th>
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

async function runBacktest() {
  const baseDate = document.getElementById("backtest-base-date").value;
  const targetDate = document.getElementById("backtest-target-date").value;
  const resultsDiv = document.getElementById("backtest-results");

  if (baseDate === targetDate) {
    resultsDiv.innerHTML = `<p class="placeholder-text">Please select two distinct dates to compute performance.</p>`;
    return;
  }

  resultsDiv.innerHTML = `<p class="placeholder-text">Computing historical performance...</p>`;

  try {
    const [resBase, resTarget] = await Promise.all([
      fetch(`../data/snapshots/${baseDate}.json`),
      fetch(`../data/snapshots/${targetDate}.json`)
    ]);

    const baseData = await resBase.json();
    const targetData = await resTarget.json();

    const baseStocks = baseData.stocks || {};
    const targetStocks = targetData.stocks || {};

    // Rank base stocks by cheapest valuation
    const rankedBase = Object.values(baseStocks)
      .filter(s => s.valuation && s.valuation.market_premium_pct !== null && targetStocks[s.ticker])
      .sort((a, b) => a.valuation.market_premium_pct - b.valuation.market_premium_pct);

    const top5Cheapest = rankedBase.slice(0, 5);

    let html = `
      <h3>Backtest: Top 5 Undervalued Stocks from ${baseDate} to ${targetDate}</h3>
      <table style="width: 100%; margin-top: 1rem;">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Base Price (${baseDate})</th>
            <th>Subsequent Price (${targetDate})</th>
            <th>Base DCF Value</th>
            <th>Return (%)</th>
          </tr>
        </thead>
        <tbody>
    `;

    let totalReturn = 0;
    top5Cheapest.forEach(s => {
      const p1 = s.market_price;
      const p2 = targetStocks[s.ticker].market_price;
      const ret = ((p2 - p1) / p1) * 100;
      totalReturn += ret;
      const retClass = ret >= 0 ? "premium-discount" : "premium-expensive";

      html += `
        <tr>
          <td><strong>${s.ticker}</strong></td>
          <td>$${p1.toFixed(2)}</td>
          <td>$${p2.toFixed(2)}</td>
          <td>$${s.valuation.intrinsic_dcf.toFixed(2)}</td>
          <td class="${retClass}">${ret > 0 ? "+" : ""}${ret.toFixed(2)}%</td>
        </tr>
      `;
    });

    const avgReturn = top5Cheapest.length > 0 ? totalReturn / top5Cheapest.length : 0;
    html += `
        </tbody>
      </table>
      <div style="margin-top: 1rem; font-weight: 600;">
        Average Basket Return: <span class="${avgReturn >= 0 ? 'premium-discount' : 'premium-expensive'}">${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(2)}%</span>
      </div>
    `;

    resultsDiv.innerHTML = html;
  } catch (err) {
    resultsDiv.innerHTML = `<p class="placeholder-text">Error running backtest: ${err.message}</p>`;
  }
}

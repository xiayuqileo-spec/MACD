const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

let currentStockQuery = "";
let currentKline = [];
let currentPeriod = 60;
let currentMacd = [];
let currentMacdPeriod = 60;
let currentTrend = [];
const FAVORITES_KEY = "a_share_favorites";

const formatNumber = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const n = Number(value);
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(digits)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(digits)}万`;
  return n.toFixed(digits);
};

const formatPct = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(2)}%`;
};

const pctClass = (value) => (Number(value) >= 0 ? "pos" : "neg");
const goStock = (code) => (window.location.href = `/stock/${encodeURIComponent(code)}`);

const getFavorites = () => {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
};

const setFavorites = (codes) => {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...new Set(codes.map((c) => String(c).padStart(6, "0")))]));
};

function setActiveView(viewName) {
  ["homeView", "quotesView", "watchlistView", "stockView"].forEach((id) => {
    const el = qs(`#${id}`);
    if (el) el.hidden = id !== `${viewName}View`;
  });
  qsa("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === viewName));
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawEmptyChart(canvas, text = "暂无数据") {
  if (!canvas) return;
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#687386";
  ctx.font = "14px Arial";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
}

function setMarketMetrics(market) {
  qsa("[data-field]", qs("#marketMetrics")).forEach((el) => {
    const field = el.dataset.field;
    if (field === "avg_pct_change") {
      el.textContent = formatPct(market[field]);
      el.className = pctClass(market[field]);
    } else if (field === "amount") {
      el.textContent = formatNumber(market[field]);
    } else {
      el.textContent = market[field] ?? "--";
    }
  });
}

function renderMarketTable(rows) {
  qs("#marketTable").innerHTML = rows
    .map(
      (row) => `
        <tr data-code="${row.code}">
          <td class="link-code">${row.code}</td>
          <td>${row.name}</td>
          <td>${formatNumber(row.price)}</td>
          <td class="${pctClass(row.pct_change)}">${formatPct(row.pct_change)}</td>
          <td>${formatNumber(row.amount)}</td>
          <td>${formatPct(row.turnover)}</td>
          <td>${formatNumber(row.pe)}</td>
          <td>${formatNumber(row.pb)}</td>
        </tr>
      `,
    )
    .join("");
  qsa("#marketTable tr").forEach((tr) => tr.addEventListener("click", () => goStock(tr.dataset.code)));
}

function renderRank(containerId, rows) {
  qs(containerId).innerHTML = rows
    .map(
      (row, idx) => `
        <div class="rank-item" data-code="${row.code}">
          <b>${idx + 1}</b>
          <span>${row.name}<small>${row.code}</small></span>
          <strong class="${pctClass(row.pct_change)}">${formatPct(row.pct_change)}</strong>
        </div>
      `,
    )
    .join("");
  qsa(`${containerId} .rank-item`).forEach((item) => item.addEventListener("click", () => goStock(item.dataset.code)));
}

function drawBreadthChart(rows) {
  const canvas = qs("#breadthChart");
  if (!rows?.length) return drawEmptyChart(canvas);
  const { ctx, width, height } = setupCanvas(canvas);
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  if (!total) return drawEmptyChart(canvas);
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2 - 10;
  const radius = Math.min(width, height) * 0.32;
  let start = -Math.PI / 2;
  rows.forEach((row) => {
    const angle = (Number(row.count) / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = row.color;
    ctx.fill();
    start += angle;
  });
  ctx.beginPath();
  ctx.fillStyle = "#fff";
  ctx.arc(cx, cy, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111827";
  ctx.font = "700 26px Arial";
  ctx.textAlign = "center";
  ctx.fillText(total, cx, cy + 6);
  ctx.font = "12px Arial";
  ctx.fillStyle = "#687386";
  ctx.fillText("全市场", cx, cy + 28);
}

function drawBarChart(canvasId, rows, options = {}) {
  const canvas = qs(canvasId);
  if (!rows?.length) return drawEmptyChart(canvas);
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 38, right: 16, top: 18, bottom: 48 };
  const max = Math.max(...rows.map((row) => Number(row.value ?? row.count ?? 0)), 1);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const gap = 8;
  const barW = Math.max(8, (plotW - gap * (rows.length - 1)) / rows.length);
  ctx.strokeStyle = "#e5eaf2";
  for (let i = 0; i < 4; i++) {
    const y = pad.top + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }
  rows.forEach((row, i) => {
    const value = Number(row.value ?? row.count ?? 0);
    const x = pad.left + i * (barW + gap);
    const h = (value / max) * plotH;
    const y = pad.top + plotH - h;
    const label = String(row.label || row.name || "");
    ctx.fillStyle = options.color || (label.startsWith("-") || label.startsWith("<") ? "#16a34a" : "#dc2626");
    ctx.fillRect(x, y, barW, h);
    ctx.save();
    ctx.translate(x + barW / 2, height - 12);
    ctx.rotate(-Math.PI / 5);
    ctx.fillStyle = "#687386";
    ctx.font = "11px Arial";
    ctx.textAlign = "right";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

function renderSentiment(market) {
  const total = Number(market.total || 0);
  const up = Number(market.up || 0);
  const down = Number(market.down || 0);
  const score = total ? Math.round((up / total) * 100) : 0;
  qs("#sentimentScore").textContent = score;
  qs("#sentimentStats").innerHTML = `
    <div><dt>上涨家数</dt><dd class="pos">${up}</dd></div>
    <div><dt>下跌家数</dt><dd class="neg">${down}</dd></div>
    <div><dt>平盘家数</dt><dd>${Number(market.flat || 0)}</dd></div>
    <div><dt>平均涨跌</dt><dd class="${pctClass(market.avg_pct_change)}">${formatPct(market.avg_pct_change)}</dd></div>
  `;
}

function drawMarketCharts(charts, market) {
  drawBreadthChart(charts?.breadth || []);
  drawBarChart("#distributionChart", charts?.pct_distribution || []);
  drawBarChart(
    "#amountChart",
    (charts?.amount_leaders || []).map((row) => ({
      label: row.name,
      value: Number(row.amount || 0) / 100000000,
    })),
    { color: "#2563eb" },
  );
  renderSentiment(market);
}

function drawTrendChart(series) {
  const canvas = qs("#marketTrendChart");
  const tooltip = qs("#trendTooltip");
  if (!series?.points?.length) return drawEmptyChart(canvas);
  currentTrend = series.points;
  qs("#trendTitle").textContent = `${series.name} 折线图`;
  qs("#trendSource").textContent = series.source || "--";
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 58, right: 18, top: 24, bottom: 36 };
  const values = currentTrend.map((d) => Number(d.close));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i) => pad.left + (i / Math.max(currentTrend.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + ((max - v) / Math.max(max - min, 0.001)) * (height - pad.top - pad.bottom);
  ctx.strokeStyle = "#e5eaf2";
  ctx.fillStyle = "#687386";
  ctx.font = "12px Arial";
  for (let i = 0; i < 5; i++) {
    const yy = pad.top + ((height - pad.top - pad.bottom) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    ctx.fillText((max - ((max - min) * i) / 4).toFixed(2), 8, yy + 4);
  }
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, "rgba(37,99,235,.22)");
  gradient.addColorStop(1, "rgba(37,99,235,0)");
  ctx.beginPath();
  currentTrend.forEach((d, i) => {
    const xx = x(i);
    const yy = y(Number(d.close));
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.lineTo(x(currentTrend.length - 1), height - pad.bottom);
  ctx.lineTo(x(0), height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  currentTrend.forEach((d, i) => {
    const xx = x(i);
    const yy = y(Number(d.close));
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2.4;
  ctx.stroke();
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(currentTrend.length - 1, Math.round(((mx - pad.left) / (width - pad.left - pad.right)) * (currentTrend.length - 1))));
    const d = currentTrend[idx];
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(width - 190, Math.max(8, x(idx) + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 20)}px`;
    tooltip.innerHTML = `<strong>${d.date}</strong><span>点位 ${formatNumber(d.close, 3)}</span><span>涨跌 ${formatPct(d.pct_change)}</span>`;
  };
  canvas.onmouseleave = () => {
    tooltip.hidden = true;
  };
}

function renderTrendCards(seriesList) {
  qs("#trendCards").innerHTML = seriesList
    .map(
      (s, idx) => `
        <button class="trend-card ${idx === 0 ? "active" : ""}" type="button" data-index="${idx}">
          <span>${s.name}</span>
          <strong>${formatNumber(s.latest, 2)}</strong>
          <em class="${pctClass(s.pct_change)}">${formatPct(s.pct_change)}</em>
        </button>
      `,
    )
    .join("");
  qsa(".trend-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      qsa(".trend-card").forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");
      drawTrendChart(seriesList[Number(btn.dataset.index)]);
    });
  });
}

async function loadTrend() {
  qs("#trendError").hidden = true;
  try {
    const res = await getJson("/api/market/trend");
    qs("#trendUpdated").textContent = `更新于 ${res.data.updated_at}`;
    renderTrendCards(res.data.series);
    drawTrendChart(res.data.series[0]);
  } catch (err) {
    qs("#trendError").textContent = err.message;
    qs("#trendError").hidden = false;
  }
}

async function loadWatchlist() {
  const codes = getFavorites();
  qs("#watchError").hidden = true;
  qs("#watchEmpty").hidden = codes.length > 0;
  qs("#watchPanel").hidden = codes.length === 0;
  if (!codes.length) return;
  try {
    const res = await getJson(`/api/quotes?codes=${codes.join(",")}`);
    qs("#watchUpdated").textContent = `共 ${res.items.length} 只`;
    qs("#watchTable").innerHTML = res.items
      .map(
        (row) => `
          <tr data-code="${row.code}">
            <td class="link-code">${row.code}</td>
            <td>${row.name}</td>
            <td>${formatNumber(row.price)}</td>
            <td class="${pctClass(row.pct_change)}">${formatPct(row.pct_change)}</td>
            <td>${formatNumber(row.amount)}</td>
            <td>${formatPct(row.turnover)}</td>
            <td><button class="table-action" data-remove="${row.code}" type="button">移除</button></td>
          </tr>
        `,
      )
      .join("");
    qsa("#watchTable tr").forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.dataset.remove) return;
      goStock(tr.dataset.code);
    }));
    qsa("[data-remove]").forEach((btn) => btn.addEventListener("click", () => {
      setFavorites(getFavorites().filter((code) => code !== btn.dataset.remove));
      loadWatchlist();
    }));
  } catch (err) {
    qs("#watchError").textContent = err.message;
    qs("#watchError").hidden = false;
  }
}

async function loadMarket(refresh = false) {
  qs("#marketError").hidden = true;
  try {
    const data = await getJson(`/api/market${refresh ? "?refresh=1" : ""}`);
    setMarketMetrics(data.market);
    drawMarketCharts(data.charts, data.market);
    renderMarketTable(data.table);
    renderRank("#gainers", data.gainers);
    renderRank("#losers", data.losers);
    qs("#marketUpdated").textContent = `更新于 ${data.updated_at}`;
  } catch (err) {
    qs("#marketError").textContent = err.message;
    qs("#marketError").hidden = false;
  }
}

function renderLatest(latest) {
  const stats = [
    ["交易日", latest.date],
    ["收盘价", formatNumber(latest.close)],
    ["涨跌幅", formatPct(latest.pct_change)],
    ["成交量", formatNumber(latest.volume)],
    ["成交额", formatNumber(latest.amount)],
    ["换手率", formatPct(latest.turnover)],
  ];
  qs("#latestStats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  qs("#latestPrice").textContent = formatNumber(latest.close);
  qs("#latestPct").textContent = formatPct(latest.pct_change);
  qs("#latestPct").className = pctClass(latest.pct_change);
}

function renderHorizons(rows) {
  qs("#horizons").innerHTML = rows
    .map(
      (row) => `
        <article class="horizon-card">
          <header><h2>${row.label}</h2><strong>${row.stance}</strong></header>
          <p>${row.summary}</p>
          <div class="levels">
            <div>支撑位<b>${formatNumber(row.support)}</b></div>
            <div>压力位<b>${formatNumber(row.pressure)}</b></div>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderIndicators(rows) {
  qs("#indicatorTable").innerHTML = rows
    .map(
      (row) => `
        <div class="indicator-row">
          <strong>${row.name}</strong>
          <span>${formatNumber(row.value, 3)}</span>
          <b>${row.signal}</b>
        </div>
      `,
    )
    .join("");
}

function renderBacktest(rows) {
  qs("#backtestTable").innerHTML = `
    <div class="backtest-row head"><strong>周期</strong><strong>均值</strong><strong>中位数</strong><strong>胜率</strong></div>
    ${rows
      .map(
        (row) => `
          <div class="backtest-row">
            <strong>${row.label}</strong>
            <span>${row.avg_return === null ? "--" : `${(row.avg_return * 100).toFixed(2)}%`}</span>
            <span>${row.median_return === null ? "--" : `${(row.median_return * 100).toFixed(2)}%`}</span>
            <span>${row.win_rate === null ? "--" : `${(row.win_rate * 100).toFixed(1)}%`}</span>
          </div>
        `,
      )
      .join("")}
  `;
}

function drawLineChart(canvasId, history) {
  const canvas = qs(canvasId);
  if (!history?.length) return drawEmptyChart(canvas);
  const { ctx, width, height } = setupCanvas(canvas);
  const points = history.filter((d) => d.close !== null);
  if (!points.length) return drawEmptyChart(canvas);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 50, right: 16, top: 20, bottom: 28 };
  const prices = points.map((d) => Number(d.close));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const x = (i) => pad.left + (i / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + ((max - v) / Math.max(max - min, 0.001)) * (height - pad.top - pad.bottom);
  ctx.strokeStyle = "#e5eaf2";
  for (let i = 0; i < 4; i++) {
    const yy = pad.top + ((height - pad.top - pad.bottom) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
  }
  ctx.beginPath();
  points.forEach((d, i) => {
    const xx = x(i);
    const yy = y(Number(d.close));
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawKlineChart(items) {
  const canvas = qs("#klineChart");
  const tooltip = qs("#chartTooltip");
  if (!items?.length) return drawEmptyChart(canvas);
  currentKline = items.filter((d) => d.close !== null);
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 58, right: 18, top: 24, bottom: 28 };
  const priceH = height * 0.72;
  const volTop = pad.top + priceH + 18;
  const volH = height - volTop - pad.bottom;
  const highs = currentKline.map((d) => Number(d.high));
  const lows = currentKline.map((d) => Number(d.low));
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const maxVol = Math.max(...currentKline.map((d) => Number(d.volume || 0)), 1);
  const plotW = width - pad.left - pad.right;
  const step = plotW / Math.max(currentKline.length, 1);
  const candleW = Math.max(3, Math.min(12, step * 0.62));
  const x = (i) => pad.left + i * step + step / 2;
  const priceY = (v) => pad.top + ((maxPrice - v) / Math.max(maxPrice - minPrice, 0.001)) * priceH;

  ctx.strokeStyle = "#e5eaf2";
  ctx.fillStyle = "#687386";
  ctx.font = "11px Arial";
  for (let i = 0; i < 5; i++) {
    const yy = pad.top + (priceH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    ctx.fillText((maxPrice - ((maxPrice - minPrice) * i) / 4).toFixed(2), 8, yy + 4);
  }
  currentKline.forEach((d, i) => {
    const open = Number(d.open);
    const close = Number(d.close);
    const high = Number(d.high);
    const low = Number(d.low);
    const up = close >= open;
    const xx = x(i);
    ctx.strokeStyle = up ? "#dc2626" : "#16a34a";
    ctx.fillStyle = up ? "#dc2626" : "#16a34a";
    ctx.beginPath();
    ctx.moveTo(xx, priceY(high));
    ctx.lineTo(xx, priceY(low));
    ctx.stroke();
    const top = Math.min(priceY(open), priceY(close));
    const h = Math.max(1, Math.abs(priceY(open) - priceY(close)));
    ctx.fillRect(xx - candleW / 2, top, candleW, h);
    const volHeight = (Number(d.volume || 0) / maxVol) * volH;
    ctx.globalAlpha = 0.42;
    ctx.fillRect(xx - candleW / 2, volTop + volH - volHeight, candleW, volHeight);
    ctx.globalAlpha = 1;
  });

  const drawMa = (key, color) => {
    ctx.beginPath();
    currentKline.forEach((d, i) => {
      const v = Number(d[key]);
      const xx = x(i);
      const yy = priceY(v);
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  };
  drawMa("ma5", "#f97316");
  drawMa("ma10", "#6366f1");
  drawMa("ma20", "#22c55e");
  drawMa("ma60", "#94a3b8");

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(currentKline.length - 1, Math.floor((mx - pad.left) / step)));
    const d = currentKline[idx];
    if (!d) return;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(width - 210, Math.max(8, x(idx) + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 20)}px`;
    tooltip.innerHTML = `
      <strong>${d.date}</strong>
      <span>开 ${formatNumber(d.open)} 高 ${formatNumber(d.high)}</span>
      <span>低 ${formatNumber(d.low)} 收 ${formatNumber(d.close)}</span>
      <span>量 ${formatNumber(d.volume)}</span>
      <span>DIF ${formatNumber(d.dif, 3)} DEA ${formatNumber(d.dea, 3)}</span>
      <span>MACD ${formatNumber(d.macd, 3)}</span>
    `;
  };
  canvas.onmouseleave = () => {
    tooltip.hidden = true;
  };
}

async function loadKline(period = currentPeriod) {
  currentPeriod = Number(period);
  qsa("#periodTabs button").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.period) === currentPeriod));
  qs("#klineSource").textContent = "加载中...";
  const data = await getJson(`/api/stock/${encodeURIComponent(currentStockQuery)}/kline?period=${currentPeriod}`);
  qs("#klineSource").textContent = data.source;
  drawKlineChart(data.items);
}

function renderDivergence(divergence) {
  const box = qs("#divergenceBox");
  const type = divergence?.type || "none";
  box.className = `divergence-box ${type}`;
  box.innerHTML = `<strong>${divergence?.title || "暂无背离"}</strong><p>${divergence?.summary || "MACD 数据不足，暂不判断。"}</p>`;
}

function drawMacdChart(items, divergence) {
  const canvas = qs("#macdChart");
  const tooltip = qs("#macdTooltip");
  if (!items?.length) return drawEmptyChart(canvas);
  currentMacd = items.filter((d) => d.macd !== null);
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 58, right: 18, top: 24, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const step = plotW / Math.max(currentMacd.length, 1);
  const barW = Math.max(3, Math.min(12, step * 0.58));
  const values = currentMacd.flatMap((d) => [Number(d.dif || 0), Number(d.dea || 0), Number(d.macd || 0)]);
  const maxAbs = Math.max(...values.map((v) => Math.abs(v)), 1);
  const x = (i) => pad.left + i * step + step / 2;
  const y = (v) => pad.top + plotH / 2 - (v / maxAbs) * (plotH / 2 - 8);
  const zero = pad.top + plotH / 2;

  ctx.strokeStyle = "#e5eaf2";
  ctx.fillStyle = "#687386";
  ctx.font = "11px Arial";
  for (let i = 0; i < 5; i++) {
    const yy = pad.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
  }
  ctx.strokeStyle = "#94a3b8";
  ctx.beginPath();
  ctx.moveTo(pad.left, zero);
  ctx.lineTo(width - pad.right, zero);
  ctx.stroke();

  currentMacd.forEach((d, i) => {
    const value = Number(d.macd || 0);
    const yy = y(value);
    ctx.fillStyle = value >= 0 ? "#dc2626" : "#16a34a";
    ctx.fillRect(x(i) - barW / 2, Math.min(zero, yy), barW, Math.max(1, Math.abs(zero - yy)));
  });

  const drawLine = (key, color) => {
    ctx.beginPath();
    currentMacd.forEach((d, i) => {
      const xx = x(i);
      const yy = y(Number(d[key] || 0));
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  };
  drawLine("dif", "#f97316");
  drawLine("dea", "#2563eb");

  ctx.fillStyle = "#f97316";
  ctx.fillText("DIF", pad.left, 14);
  ctx.fillStyle = "#2563eb";
  ctx.fillText("DEA", pad.left + 42, 14);
  ctx.fillStyle = "#64748b";
  ctx.fillText("MACD柱", pad.left + 84, 14);

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(currentMacd.length - 1, Math.floor((mx - pad.left) / step)));
    const d = currentMacd[idx];
    if (!d) return;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(width - 190, Math.max(8, x(idx) + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 20)}px`;
    tooltip.innerHTML = `
      <strong>${d.date}</strong>
      <span>DIF ${formatNumber(d.dif, 3)}</span>
      <span>DEA ${formatNumber(d.dea, 3)}</span>
      <span>MACD ${formatNumber(d.macd, 3)}</span>
      <span>收盘 ${formatNumber(d.close)}</span>
    `;
  };
  canvas.onmouseleave = () => {
    tooltip.hidden = true;
  };
  renderDivergence(divergence);
}

async function loadMacd(period = currentMacdPeriod) {
  currentMacdPeriod = Number(period);
  qsa("#macdPeriodTabs button").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.period) === currentMacdPeriod));
  qs("#macdSource").textContent = "MACD加载中...";
  const data = await getJson(`/api/stock/${encodeURIComponent(currentStockQuery)}/kline?period=${currentMacdPeriod}`);
  qs("#macdSource").textContent = `${data.period}分钟 · ${data.source}`;
  drawMacdChart(data.items, data.divergence);
}

async function loadStock(query) {
  currentStockQuery = String(query).trim();
  const initialCode = /^\d+$/.test(currentStockQuery) ? currentStockQuery.padStart(6, "0") : currentStockQuery;
  qs("#homeView").hidden = true;
  qs("#quotesView").hidden = true;
  qs("#watchlistView").hidden = true;
  qs("#stockView").hidden = false;
  qs("#stockLoading").hidden = false;
  qs("#stockLoading").textContent = "正在加载K线，分析结果会随后补充...";
  qs("#stockContent").hidden = false;
  qs("#stockError").hidden = true;
  qs("#stockName").textContent = initialCode;
  qs("#stockCode").textContent = initialCode;
  qs("#stockConclusion").textContent = "正在计算短中长期量化结论...";
  qs("#stockUpdated").textContent = "--";
  qs("#latestPrice").textContent = "--";
  qs("#latestPct").textContent = "--";
  qs("#latestStats").innerHTML = "";
  qs("#indicatorTable").innerHTML = "";
  qs("#backtestTable").innerHTML = "";
  qs("#horizons").innerHTML = "";
  updateFavoriteButton(initialCode);
  qs("#klineSource").textContent = "等待基础行情加载...";
  try {
    const res = await getJson(`/api/stock/${encodeURIComponent(query)}`);
    const data = res.data;
    currentStockQuery = data.code;
    qs("#stockName").textContent = data.name;
    qs("#stockCode").textContent = data.code;
    updateFavoriteButton(data.code);
    qs("#stockConclusion").textContent = data.overall.conclusion;
    qs("#stockUpdated").textContent = `更新 ${data.updated_at}`;
    renderLatest(data.latest);
    renderHorizons(data.horizons);
    renderIndicators(data.indicators);
    renderBacktest(data.backtest.rows);
    drawLineChart("#priceChart", data.history);
    qs("#stockLoading").hidden = true;
    loadKline(60).catch((err) => {
      qs("#klineSource").textContent = err.message;
    });
    loadMacd(60).catch((err) => {
      qs("#macdSource").textContent = err.message;
    });
  } catch (err) {
    qs("#stockLoading").hidden = true;
    qs("#stockError").textContent = err.message;
    qs("#stockError").hidden = false;
  }
}

function updateFavoriteButton(code) {
  const button = qs("#favoriteBtn");
  const exists = getFavorites().includes(String(code).padStart(6, "0"));
  button.textContent = exists ? "已加入自选" : "加入自选";
  button.dataset.code = code;
  button.classList.toggle("is-added", exists);
}

function setupSearch() {
  const form = qs("#searchForm");
  const input = qs("#searchInput");
  const suggestions = qs("#suggestions");
  let timer = null;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (q) goStock(q);
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      suggestions.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const data = await getJson(`/api/search?q=${encodeURIComponent(q)}`);
        suggestions.innerHTML = data.items
          .map(
            (item) => `
              <button class="suggestion" type="button" data-code="${item.code}">
                <span>${item.name} <small>${item.code}</small></span>
                <strong class="${pctClass(item.pct_change)}">${formatPct(item.pct_change)}</strong>
              </button>
            `,
          )
          .join("");
        suggestions.hidden = data.items.length === 0;
        qsa(".suggestion", suggestions).forEach((btn) => btn.addEventListener("click", () => goStock(btn.dataset.code)));
      } catch {
        suggestions.hidden = true;
      }
    }, 220);
  });
  document.addEventListener("click", (event) => {
    if (!form.contains(event.target)) suggestions.hidden = true;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupSearch();
  qs("#refreshBtn")?.addEventListener("click", () => loadMarket(true));
  qs("#trendRefreshBtn")?.addEventListener("click", () => loadTrend());
  qs("#watchRefreshBtn")?.addEventListener("click", () => loadWatchlist());
  qs("#favoriteBtn")?.addEventListener("click", () => {
    const code = qs("#favoriteBtn").dataset.code;
    const current = getFavorites();
    if (current.includes(code)) setFavorites(current.filter((item) => item !== code));
    else setFavorites([...current, code]);
    updateFavoriteButton(code);
  });
  qsa("[data-view-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const view = link.dataset.viewLink;
      history.replaceState(null, "", view === "home" ? "/" : `#${view}`);
      setActiveView(view);
      if (view === "home") loadMarket();
      if (view === "quotes") loadTrend();
      if (view === "watchlist") loadWatchlist();
    });
  });
  qsa("#periodTabs button").forEach((btn) => btn.addEventListener("click", () => loadKline(btn.dataset.period)));
  qsa("#macdPeriodTabs button").forEach((btn) => btn.addEventListener("click", () => loadMacd(btn.dataset.period)));
  const stockQuery = document.body.dataset.stockQuery;
  if (stockQuery) loadStock(stockQuery);
  else if (location.hash === "#quotes") {
    setActiveView("quotes");
    loadTrend();
  } else if (location.hash === "#watchlist") {
    setActiveView("watchlist");
    loadWatchlist();
  } else {
    setActiveView("home");
    loadMarket();
  }
});

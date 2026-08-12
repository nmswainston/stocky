// Page state and fetch loops. Rendering lives in candles.js and
// equity.js; this file only moves data between the API and the charts.

import { countGaps, createPriceChart } from './candles.js';
import { createEquityChart, fillMarkers, summarize } from './equity.js';
import { createPaperChart, paperCardData, paperSummarize } from './paper.js';
import { localDateTime, localTime } from './time.js';

const el = (id) => document.getElementById(id);

const state = {
  symbol: 'BTC-USD',
  rangeMinutes: 1440,
  previousStatus: null,
};

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

function renderStatus(status) {
  const dot = el('status-dot');
  const ageMs = status.lastMessageAt ? Date.now() - Date.parse(status.lastMessageAt) : Infinity;
  const healthy = status.connected && ageMs < 15_000;
  dot.className = `dot ${healthy ? 'ok' : 'bad'}`;
  el('status-text').textContent = healthy ? 'live' : status.connected ? 'stalled' : 'disconnected';

  const previous = state.previousStatus;
  if (previous) {
    const seconds = status.uptimeSeconds - previous.uptimeSeconds;
    const rate = seconds > 0 ? (status.messagesReceived - previous.messagesReceived) / seconds : 0;
    el('stat-rate').textContent = rate.toFixed(1);
  }
  state.previousStatus = status;

  el('stat-gaps').textContent = status.gapCount;
  el('stat-gaps').className = status.gapCount > 0 ? 'warn' : '';
  el('stat-reconnects').textContent = status.reconnectCount;
  el('stat-trades').textContent = status.tradesWritten.toLocaleString();
  el('stat-bars').textContent = status.barsWritten.toLocaleString();
  el('stat-last').textContent = ageMs === Infinity ? 'never' : `${(ageMs / 1000).toFixed(1)}s ago`;
  el('stat-last').className = ageMs > 15_000 ? 'bad' : '';
}

const formatPrice = (value) =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function statusLoop() {
  try {
    renderStatus(await fetchJson('/api/status'));
    const { ticker } = await fetchJson('/api/ticker');
    el('stat-prices').textContent = ticker
      .map((entry) => `${entry.symbol.replace('-USD', '')} ${formatPrice(entry.price)}`)
      .join('   ');
    // Tab title carries the selected symbol's price, glanceable from
    // any other window.
    const selected = ticker.find((entry) => entry.symbol === state.symbol);
    if (selected) {
      document.title = `${state.symbol.replace('-USD', '')} ${formatPrice(selected.price)} · stocky`;
    }
  } catch {
    el('status-dot').className = 'dot bad';
    el('status-text').textContent = 'collector unreachable';
  }
  setTimeout(statusLoop, 5_000);
}

async function tapeLoop() {
  try {
    const { trades } = await fetchJson(
      `/api/trades?symbol=${encodeURIComponent(state.symbol)}&limit=30`,
    );
    el('trade-tape').innerHTML = trades
      .map(
        (trade) =>
          `<div class="tape-row"><span>${localTime(trade.time)}</span>` +
          `<span class="price ${trade.side === 'BUY' ? 'buy' : 'sell'}">${formatPrice(trade.price)}</span>` +
          `<span class="size">${Number(trade.size).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}</span></div>`,
      )
      .join('');
  } catch {
    /* tape is decoration; the next tick retries */
  }
  setTimeout(tapeLoop, 5_000);
}

const priceChart = createPriceChart(el('price-chart'));
let barsTimer = null;

async function loadBars({ fit = false } = {}) {
  try {
    const data = await fetchJson(
      `/api/bars?symbol=${encodeURIComponent(state.symbol)}&limit=${state.rangeMinutes}`,
    );
    priceChart.setBars(data.bars, { fit });
    const missing = countGaps(data.bars);
    el('bar-info').textContent =
      `${data.count} bars` + (missing > 0 ? `, ${missing} missing` : '');
  } catch (error) {
    el('bar-info').textContent = `bars unavailable: ${error.message}`;
  }
}

function scheduleBars() {
  if (barsTimer) clearInterval(barsTimer);
  // Bars only change once a minute; refresh on the minute plus slack.
  barsTimer = setInterval(loadBars, 60_000);
}

el('symbol-select').addEventListener('change', (event) => {
  state.symbol = event.target.value;
  loadBars({ fit: true });
  scheduleBars();
});

el('range-select').addEventListener('change', (event) => {
  state.rangeMinutes = Number(event.target.value);
  loadBars({ fit: true });
  scheduleBars();
});

const equityChart = createEquityChart(el('equity-chart'));
let selectedBacktest = null;

async function refreshBacktestList() {
  try {
    const { backtests } = await fetchJson('/api/backtests');
    const select = el('backtest-select');
    const current = select.value;
    select.innerHTML = '';
    if (backtests.length === 0) {
      select.append(new Option('none saved yet', ''));
      return;
    }
    select.append(new Option('select a backtest', ''));
    for (const summary of backtests) {
      const pct = summary.totalReturnPct === null
        ? ''
        : ` ${(summary.totalReturnPct * 100).toFixed(2)}%`;
      select.append(
        new Option(`${summary.strategyName} ${summary.symbol}${pct}`, summary.id),
      );
    }
    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  } catch {
    /* list refresh is best effort; the next tick retries */
  }
}

const paperChart = createPaperChart(el('paper-chart'));
let selectedPaper = null;

// One marker owner at a time: whichever of paper or backtest was
// selected last draws its fills on the price chart.
function applyMarkers() {
  if (selectedPaper && selectedPaper.config.symbol === state.symbol) {
    priceChart.setMarkers(fillMarkers({ fills: selectedPaper.main.fills }));
  } else if (selectedBacktest && selectedBacktest.result.config.symbol === state.symbol) {
    priceChart.setMarkers(fillMarkers(selectedBacktest.result));
  } else {
    priceChart.setMarkers([]);
  }
}
const applyBacktestMarkers = applyMarkers;

async function refreshPaperList() {
  try {
    const { sessions } = await fetchJson('/api/paper');
    const select = el('paper-select');
    const current = select.value;
    select.innerHTML = '';
    if (sessions.length === 0) {
      select.append(new Option('no sessions yet', ''));
      return;
    }
    select.append(new Option('select a session', ''));
    for (const session of sessions) {
      const initial = Number(session.initialEquity);
      const pct = initial > 0
        ? ` ${(((Number(session.equity) - initial) / initial) * 100).toFixed(2)}%`
        : '';
      const tf = ` ${session.timeframeMinutes ?? 1}m`;
      select.append(new Option(`${session.strategyName} ${session.symbol}${tf}${pct}`, session.id));
    }
    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  } catch {
    /* best effort, retried on the next tick */
  }
}

function renderPaperDetails(state) {
  const card = paperCardData(state);
  const gainLoss = (value) => (value >= 0 ? 'gain' : 'loss');
  el('card-equity').textContent = formatPrice(card.equity);
  const returnEl = el('card-return');
  returnEl.textContent = `${card.returnPct >= 0 ? '+' : ''}${card.returnPct.toFixed(2)}%`;
  returnEl.className = `pnl-return ${gainLoss(card.returnPct)}`;
  const deltaEl = el('card-delta');
  deltaEl.textContent = `${card.deltaPoints >= 0 ? '+' : ''}${card.deltaPoints.toFixed(2)} pts`;
  deltaEl.className = gainLoss(card.deltaPoints);
  el('paper-card').classList.remove('hidden');

  const fills = state.main.fills.slice(-15).reverse();
  const table = el('paper-fills');
  if (fills.length === 0) {
    table.classList.add('hidden');
  } else {
    table.querySelector('tbody').innerHTML = fills
      .map(
        (fill) =>
          `<tr><td>${localDateTime(fill.executedAtBar)}</td>` +
          `<td class="${fill.side === 'BUY' ? 'gain' : 'loss'}">${fill.side}</td>` +
          `<td>${formatPrice(fill.fillPrice)}</td>` +
          `<td>${Number(fill.quantity).toFixed(6)}</td>` +
          `<td>${Number(fill.fee).toFixed(2)}</td></tr>`,
      )
      .join('');
    table.classList.remove('hidden');
  }
}

function hidePaperDetails() {
  el('paper-card').classList.add('hidden');
  el('paper-fills').classList.add('hidden');
}

async function loadPaperSession(id, { fitSymbol = true } = {}) {
  selectedPaper = await fetchJson(`/api/paper/${id}`);
  el('paper-summary').textContent = paperSummarize(selectedPaper);
  renderPaperDetails(selectedPaper);
  paperChart.setCurves(selectedPaper.main.equityCurve, selectedPaper.baseline.equityCurve);
  if (fitSymbol && selectedPaper.config.symbol !== state.symbol) {
    el('symbol-select').value = selectedPaper.config.symbol;
    state.symbol = selectedPaper.config.symbol;
    await loadBars({ fit: true });
    scheduleBars();
  }
  applyMarkers();
}

el('paper-select').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id) {
    selectedPaper = null;
    paperChart.clear();
    el('paper-summary').textContent = '';
    hidePaperDetails();
    applyMarkers();
    return;
  }
  try {
    selectedBacktest = null;
    el('backtest-select').value = '';
    equityChart.clear();
    el('backtest-summary').textContent = '';
    await loadPaperSession(id);
  } catch (error) {
    el('paper-summary').textContent = `could not load session: ${error.message}`;
  }
});

// A live session keeps moving; refresh the selected one each minute.
setInterval(() => {
  if (selectedPaper) {
    loadPaperSession(selectedPaper.config.id, { fitSymbol: false }).catch(() => {});
  }
}, 60_000);

el('backtest-select').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id) {
    selectedBacktest = null;
    equityChart.clear();
    el('backtest-summary').textContent = '';
    applyBacktestMarkers();
    return;
  }
  try {
    selectedPaper = null;
    el('paper-select').value = '';
    paperChart.clear();
    el('paper-summary').textContent = '';
    hidePaperDetails();
    selectedBacktest = await fetchJson(`/api/backtests/${id}`);
    const result = selectedBacktest.result;
    el('backtest-summary').textContent = summarize(result);
    equityChart.setResult(result);
    if (result.config.symbol !== state.symbol) {
      el('symbol-select').value = result.config.symbol;
      state.symbol = result.config.symbol;
      await loadBars({ fit: true });
      scheduleBars();
    }
    applyBacktestMarkers();
  } catch (error) {
    el('backtest-summary').textContent = `could not load backtest: ${error.message}`;
  }
});

el('symbol-select').addEventListener('change', applyBacktestMarkers);

statusLoop();
tapeLoop();
loadBars({ fit: true });
scheduleBars();
refreshBacktestList();
setInterval(refreshBacktestList, 30_000);
refreshPaperList();
setInterval(refreshPaperList, 30_000);

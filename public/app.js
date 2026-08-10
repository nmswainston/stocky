// Page state and fetch loops. Rendering lives in candles.js and
// equity.js; this file only moves data between the API and the charts.

import { countGaps, createPriceChart } from './candles.js';
import { createEquityChart, fillMarkers, summarize } from './equity.js';

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

async function statusLoop() {
  try {
    renderStatus(await fetchJson('/api/status'));
  } catch {
    el('status-dot').className = 'dot bad';
    el('status-text').textContent = 'collector unreachable';
  }
  setTimeout(statusLoop, 5_000);
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

function applyBacktestMarkers() {
  if (selectedBacktest && selectedBacktest.result.config.symbol === state.symbol) {
    priceChart.setMarkers(fillMarkers(selectedBacktest.result));
  } else {
    priceChart.setMarkers([]);
  }
}

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
loadBars({ fit: true });
scheduleBars();
refreshBacktestList();
setInterval(refreshBacktestList, 30_000);

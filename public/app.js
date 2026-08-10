// Page state and fetch loops. Rendering lives in candles.js and
// equity.js; this file only moves data between the API and the charts.

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

statusLoop();

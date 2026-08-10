// Equity curve rendering and trade marker construction for a saved
// backtest result.

const COLORS = {
  above: '#2ea043',
  below: '#f85149',
  grid: '#1b2129',
  text: '#8b949e',
};

export function createEquityChart(container) {
  const chart = LightweightCharts.createChart(container, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: COLORS.text },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
  });

  // Baseline at initial equity: green above the starting stake, red
  // below. The line answers "am I up or down" at a glance.
  let series = null;

  return {
    setResult(result) {
      if (series) chart.removeSeries(series);
      series = chart.addSeries(LightweightCharts.BaselineSeries, {
        baseValue: { type: 'price', price: Number(result.config.initialEquity) },
        topLineColor: COLORS.above,
        bottomLineColor: COLORS.below,
        topFillColor1: 'rgba(46, 160, 67, 0.25)',
        topFillColor2: 'rgba(46, 160, 67, 0.02)',
        bottomFillColor1: 'rgba(248, 81, 73, 0.02)',
        bottomFillColor2: 'rgba(248, 81, 73, 0.25)',
        lineWidth: 2,
      });
      series.setData(
        result.equityCurve.map((point) => ({
          time: Math.floor(Date.parse(point.time) / 1000),
          value: Number(point.equity),
        })),
      );
      chart.timeScale().fitContent();
    },
    clear() {
      if (series) chart.removeSeries(series);
      series = null;
    },
  };
}

// Markers for the price chart: entries below the bar, exits above it,
// placed at the execution bar. decidedAtBar is in the tooltip text so
// the one-bar decision-to-fill delay stays visible.
export function fillMarkers(result) {
  return result.fills.map((fill) => ({
    time: Math.floor(Date.parse(fill.executedAtBar) / 1000),
    position: fill.side === 'BUY' ? 'belowBar' : 'aboveBar',
    color: fill.side === 'BUY' ? COLORS.above : COLORS.below,
    shape: fill.side === 'BUY' ? 'arrowUp' : 'arrowDown',
    text: `${fill.side} ${Number(fill.quantity).toFixed(5)} @ ${Number(fill.fillPrice).toFixed(2)} (decided ${fill.decidedAtBar.slice(11, 16)})`,
  }));
}

export function summarize(result) {
  const pct = (value) =>
    value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`;
  return [
    `${result.strategyName} on ${result.config.symbol}`,
    `${result.data.barCount} bars (${result.data.missingBars} missing)`,
    `net ${pct(result.costs.netReturnPct)} vs gross ${pct(result.costs.grossReturnPct)}`,
    `fees ${Number(result.costs.totalFees).toFixed(2)}`,
    `${result.trades.fillCount} fills`,
    `max dd ${pct(result.performance.maxDrawdownPct)}`,
  ].join('  ·  ');
}

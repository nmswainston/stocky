// Paper session rendering: the strategy's equity and its buy-and-hold
// baseline on one chart, because "am I beating doing nothing" is the
// only paper trading question that matters.

import { toChartTime } from './time.js';

const COLORS = {
  strategy: '#58a6ff',
  baseline: '#6e7681',
  grid: '#1b2129',
  text: '#8b949e',
};

export function createPaperChart(container) {
  const chart = LightweightCharts.createChart(container, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: COLORS.text },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
  });

  const strategySeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: COLORS.strategy,
    lineWidth: 2,
    title: 'strategy',
  });
  const baselineSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: COLORS.baseline,
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    title: 'buy & hold',
  });

  const toPoints = (curve) =>
    curve.map((point) => ({
      time: toChartTime(point.time),
      value: Number(point.equity),
    }));

  return {
    setCurves(mainCurve, baselineCurve) {
      strategySeries.setData(toPoints(mainCurve));
      baselineSeries.setData(toPoints(baselineCurve));
      chart.timeScale().fitContent();
    },
    clear() {
      strategySeries.setData([]);
      baselineSeries.setData([]);
    },
  };
}

export function paperCardData(state) {
  const initial = Number(state.config.initialEquity);
  const last = (curve) =>
    curve.length > 0 ? Number(curve[curve.length - 1].equity) : initial;
  const equity = last(state.main.equityCurve);
  const baseline = last(state.baseline.equityCurve);
  const returnPct = ((equity - initial) / initial) * 100;
  const baselinePct = ((baseline - initial) / initial) * 100;
  return {
    equity,
    returnPct,
    // Percentage points ahead of (positive) or behind (negative) doing
    // nothing: the number that actually judges a strategy.
    deltaPoints: returnPct - baselinePct,
  };
}

export function paperSummarize(state) {
  const initial = Number(state.config.initialEquity);
  const last = (curve) =>
    curve.length > 0 ? Number(curve[curve.length - 1].equity) : initial;
  const pct = (value) => `${(((value - initial) / initial) * 100).toFixed(2)}%`;
  const main = last(state.main.equityCurve);
  const baseline = last(state.baseline.equityCurve);
  const ageMinutes = state.lastProcessedBar
    ? Math.round((Date.now() - Date.parse(state.lastProcessedBar)) / 60_000)
    : null;
  return [
    `${state.config.strategyName} on ${state.config.symbol} ${state.config.timeframeMinutes ?? 1}m`,
    `strategy ${pct(main)} vs baseline ${pct(baseline)}`,
    `${state.main.fills.length} fills`,
    `${state.gaps.length} gaps`,
    ageMinutes === null ? 'no bars yet' : `last bar ${ageMinutes}m ago`,
  ].join('  ·  ');
}

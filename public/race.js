// The race: every paper session's return overlaid on one chart, in
// percent so different symbols and stakes compare honestly, with the
// distinct buy-and-hold baselines as dashed gray reference lines.

const COLORS = {
  grid: '#1b2129',
  text: '#8b949e',
  baseline: '#6e7681',
};

export const RACE_PALETTE = ['#58a6ff', '#bc8cff', '#ffa657', '#39c5cf', '#ff7b72', '#7ee787'];

export function createRaceChart(container) {
  const chart = LightweightCharts.createChart(container, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: COLORS.text },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
    localization: { priceFormatter: (value) => `${value.toFixed(2)}%` },
  });

  let series = [];

  return {
    // entries: { label, color, dashed, initial, curve: [{time, equity}] }
    setEntries(entries) {
      for (const existing of series) chart.removeSeries(existing);
      series = entries.map((entry) => {
        const line = chart.addSeries(LightweightCharts.LineSeries, {
          color: entry.color,
          lineWidth: entry.dashed ? 1 : 2,
          lineStyle: entry.dashed
            ? LightweightCharts.LineStyle.Dashed
            : LightweightCharts.LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        line.setData(
          entry.curve.map((point) => ({
            time: Math.floor(Date.parse(point.time) / 1000),
            value: ((Number(point.equity) - entry.initial) / entry.initial) * 100,
          })),
        );
        return line;
      });
      chart.timeScale().fitContent();
    },
  };
}

export function lastReturnPct(curve, initial) {
  if (curve.length === 0) return 0;
  return ((Number(curve[curve.length - 1].equity) - initial) / initial) * 100;
}

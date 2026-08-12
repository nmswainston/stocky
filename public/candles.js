// Candlestick and volume rendering. Uses the lightweight-charts v5
// standalone global. This module never fetches; app.js feeds it.

import { toChartTime } from './time.js';

const COLORS = {
  up: '#2ea043',
  down: '#f85149',
  volume: '#30363d',
  grid: '#1b2129',
  text: '#8b949e',
  // Bars the collector marked lossy render with amber borders and a
  // faded body: visibly suspect, direction still readable.
  incomplete: '#d29922',
  upFaded: 'rgba(46, 160, 67, 0.35)',
  downFaded: 'rgba(248, 81, 73, 0.35)',
};

export function createPriceChart(container) {
  const chart = LightweightCharts.createChart(container, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: COLORS.text },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });

  const candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: COLORS.up,
    downColor: COLORS.down,
    borderUpColor: COLORS.up,
    borderDownColor: COLORS.down,
    wickUpColor: COLORS.up,
    wickDownColor: COLORS.down,
  });

  const volume = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceScaleId: 'volume',
    priceFormat: { type: 'volume' },
    color: COLORS.volume,
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  const markers = LightweightCharts.createSeriesMarkers(candles, []);

  return {
    setBars(bars, { fit = false } = {}) {
      candles.setData(
        bars.map((bar) => {
          const point = {
            time: toChartTime(bar.bucketStart),
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close),
          };
          if (bar.complete === false) {
            const up = point.close >= point.open;
            return {
              ...point,
              color: up ? COLORS.upFaded : COLORS.downFaded,
              borderColor: COLORS.incomplete,
              wickColor: COLORS.incomplete,
            };
          }
          return point;
        }),
      );
      volume.setData(
        bars.map((bar) => ({
          time: toChartTime(bar.bucketStart),
          value: Number(bar.volume),
        })),
      );
      if (fit) chart.timeScale().fitContent();
    },
    setMarkers(markerList) {
      markers.setMarkers(markerList);
    },
  };
}

// Minutes missing between consecutive bars: the dashboard's honesty
// metric, shown next to the bar count instead of being smoothed over.
export function countGaps(bars) {
  let missing = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const step = (Date.parse(bars[i].bucketStart) - Date.parse(bars[i - 1].bucketStart)) / 60_000;
    missing += Math.max(0, Math.round(step) - 1);
  }
  return missing;
}

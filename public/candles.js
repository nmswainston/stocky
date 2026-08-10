// Candlestick and volume rendering. Uses the lightweight-charts v5
// standalone global. This module never fetches; app.js feeds it.

const COLORS = {
  up: '#2ea043',
  down: '#f85149',
  volume: '#30363d',
  grid: '#1b2129',
  text: '#8b949e',
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
        bars.map((bar) => ({
          time: Math.floor(Date.parse(bar.bucketStart) / 1000),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
        })),
      );
      volume.setData(
        bars.map((bar) => ({
          time: Math.floor(Date.parse(bar.bucketStart) / 1000),
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

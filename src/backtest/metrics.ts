import { fromUnits, toUnits } from '../decimal.js';
import type { ReplayOutcome } from './engine.js';
import type { BacktestConfig, BacktestResult, ClosedBar, RoundTrip, Strategy } from './types.js';

// Metric calculations. Everything here is a pure function of its inputs,
// and this is the one layer where floats are allowed: these are summary
// ratios, not accounting. Money never flows back out of this module.

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const BAR_MS = 60_000;

export function totalReturnPct(initialUnits: bigint, finalUnits: bigint): number {
  return Number(finalUnits - initialUnits) / Number(initialUnits);
}

// Compound growth extrapolated to a 365 day crypto year. Honest only
// over long spans; the report warns when the span is short.
export function annualizedReturnPct(
  initialUnits: bigint,
  finalUnits: bigint,
  spanMs: number,
): number {
  if (spanMs <= 0) return 0;
  const growth = Number(finalUnits) / Number(initialUnits);
  return growth ** (MS_PER_YEAR / spanMs) - 1;
}

// Sharpe from per-bar simple returns, risk free rate zero, annualized by
// the square root of bars per year. Sample standard deviation. Null when
// there is nothing to divide: fewer than two returns, or zero variance.
export function sharpeRatio(equitySeries: readonly number[]): number | null {
  if (equitySeries.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < equitySeries.length; i += 1) {
    const previous = equitySeries[i - 1] as number;
    const current = equitySeries[i] as number;
    if (previous <= 0) return null;
    returns.push(current / previous - 1);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  if (variance === 0) return null;
  const barsPerYear = MS_PER_YEAR / BAR_MS;
  return (mean / Math.sqrt(variance)) * Math.sqrt(barsPerYear);
}

export interface DrawdownReport {
  maxDrawdownPct: number;
  duration: { bars: number; from: string; to: string } | null;
}

// Magnitude is the deepest peak-to-trough drop. Duration is the longest
// stretch spent below a prior peak, peak bar to recovery bar, measured
// to the final bar when the curve never recovers.
export function maxDrawdown(
  equitySeries: readonly number[],
  times: readonly string[],
): DrawdownReport {
  let peak = -Infinity;
  let peakIndex = 0;
  let dipped = false;
  let deepest = 0;
  let longest: { bars: number; from: string; to: string } | null = null;

  // Only a stretch that actually went below the peak counts as
  // underwater; consecutive new highs are not a drawdown.
  const consider = (endIndex: number): void => {
    const bars = endIndex - peakIndex;
    if (dipped && bars > 0 && (longest === null || bars > longest.bars)) {
      longest = { bars, from: times[peakIndex] as string, to: times[endIndex] as string };
    }
  };

  for (let i = 0; i < equitySeries.length; i += 1) {
    const equity = equitySeries[i] as number;
    if (equity >= peak) {
      if (peak !== -Infinity) consider(i);
      peak = equity;
      peakIndex = i;
      dipped = false;
    } else {
      dipped = true;
      const drawdown = (peak - equity) / peak;
      if (drawdown > deepest) deepest = drawdown;
    }
  }
  consider(equitySeries.length - 1);

  return { maxDrawdownPct: deepest, duration: longest };
}

export interface WinStats {
  winRate: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
}

// A round trip with exactly zero pnl counts as a loss: it paid fees for
// nothing. Null (not zero) when there were no round trips at all.
export function winStats(roundTrips: readonly RoundTrip[]): WinStats {
  if (roundTrips.length === 0) {
    return { winRate: null, averageWinPct: null, averageLossPct: null };
  }
  const wins = roundTrips.filter((t) => t.netPnlPct > 0);
  const losses = roundTrips.filter((t) => t.netPnlPct <= 0);
  const average = (list: readonly RoundTrip[]): number | null =>
    list.length === 0 ? null : list.reduce((sum, t) => sum + t.netPnlPct, 0) / list.length;
  return {
    winRate: wins.length / roundTrips.length,
    averageWinPct: average(wins),
    averageLossPct: average(losses),
  };
}

// Bars the collector should have produced over the span versus bars
// present. Reported, never repaired: fabricating bridge bars would let
// strategies trade through collector outages.
export function missingBarCount(bars: readonly ClosedBar[]): number {
  if (bars.length < 2) return 0;
  const first = Date.parse((bars[0] as ClosedBar).bucketStart);
  const last = Date.parse((bars[bars.length - 1] as ClosedBar).bucketStart);
  const expected = Math.round((last - first) / BAR_MS) + 1;
  return expected - bars.length;
}

export function assembleResult<State>(
  strategy: Strategy<State>,
  bars: readonly ClosedBar[],
  config: BacktestConfig,
  outcome: ReplayOutcome,
): BacktestResult {
  const initialUnits = toUnits(config.initialEquity);
  const firstBar = (bars[0] as ClosedBar).bucketStart;
  const lastBar = (bars[bars.length - 1] as ClosedBar).bucketStart;
  const spanMs = Date.parse(lastBar) + BAR_MS - Date.parse(firstBar);

  const equityNumbers = outcome.equityCurve.map((point) => Number(point.equity));
  const times = outcome.equityCurve.map((point) => point.time);
  const drawdown = maxDrawdown(equityNumbers, times);
  const wins = winStats(outcome.roundTrips);

  return {
    strategyName: strategy.name,
    config,
    data: {
      firstBar,
      lastBar,
      barCount: bars.length,
      missingBars: missingBarCount(bars),
      warmupBarsExcluded: outcome.warmupBarsExcluded,
    },
    performance: {
      finalEquity: fromUnits(outcome.finalEquityUnits),
      totalReturnPct: totalReturnPct(initialUnits, outcome.finalEquityUnits),
      annualizedReturnPct: annualizedReturnPct(initialUnits, outcome.finalEquityUnits, spanMs),
      sharpeRatio: sharpeRatio(equityNumbers),
      maxDrawdownPct: drawdown.maxDrawdownPct,
      maxDrawdownDuration: drawdown.duration,
    },
    trades: {
      fillCount: outcome.fills.length,
      roundTripCount: outcome.roundTrips.length,
      winRate: wins.winRate,
      averageWinPct: wins.averageWinPct,
      averageLossPct: wins.averageLossPct,
      openPositionAtEnd: outcome.openPositionAtEnd,
      undecidedSignalAtEnd: outcome.undecidedSignalAtEnd,
    },
    costs: {
      grossReturnPct: totalReturnPct(initialUnits, outcome.grossFinalEquityUnits),
      netReturnPct: totalReturnPct(initialUnits, outcome.finalEquityUnits),
      totalFees: fromUnits(outcome.totalFeesUnits),
      totalSlippage: fromUnits(outcome.totalSlippageUnits),
    },
    equityCurve: outcome.equityCurve,
    fills: outcome.fills,
    roundTrips: outcome.roundTrips,
  };
}

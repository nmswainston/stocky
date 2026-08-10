import { fromUnits, toUnits } from '../decimal.js';
import type { ClosedBar } from './types.js';

// Folds 1 minute bars into N minute bars, epoch aligned. Interior gaps
// stay gaps: a bucket missing some minutes aggregates what exists, same
// honesty rule as everywhere else. The trailing bucket is emitted only
// when the data proves its period ended, either because a later bar
// exists past it or because it contains its own closing minute.
// Emitting a possibly-still-open bucket would reintroduce the repaint
// class of look-ahead at the higher timeframe.

interface Accumulator {
  bucketStartMs: number;
  open: string;
  close: string;
  highUnits: bigint;
  lowUnits: bigint;
  volumeUnits: bigint;
  tradeCount: number;
  lastMinuteMs: number;
}

export function aggregateBars(
  bars: readonly ClosedBar[],
  timeframeMinutes: number,
): ClosedBar[] {
  if (!Number.isInteger(timeframeMinutes) || timeframeMinutes < 1) {
    throw new Error(`timeframe must be a positive integer of minutes, got ${timeframeMinutes}`);
  }
  if (timeframeMinutes === 1 || bars.length === 0) return [...bars];

  const bucketMs = timeframeMinutes * 60_000;
  const symbol = (bars[0] as ClosedBar).symbol;
  const result: ClosedBar[] = [];
  let current: Accumulator | null = null;

  const emit = (accumulator: Accumulator): void => {
    result.push(
      Object.freeze({
        symbol,
        bucketStart: new Date(accumulator.bucketStartMs).toISOString(),
        open: accumulator.open,
        high: fromUnits(accumulator.highUnits),
        low: fromUnits(accumulator.lowUnits),
        close: accumulator.close,
        volume: fromUnits(accumulator.volumeUnits),
        tradeCount: accumulator.tradeCount,
      }),
    );
  };

  for (const bar of bars) {
    const minuteMs = Date.parse(bar.bucketStart);
    const bucketStartMs = Math.floor(minuteMs / bucketMs) * bucketMs;
    const highUnits = toUnits(bar.high);
    const lowUnits = toUnits(bar.low);

    if (current && bucketStartMs !== current.bucketStartMs) {
      // A bar beyond the bucket proves the bucket's period elapsed.
      emit(current);
      current = null;
    }

    if (!current) {
      current = {
        bucketStartMs,
        open: bar.open,
        close: bar.close,
        highUnits,
        lowUnits,
        volumeUnits: toUnits(bar.volume),
        tradeCount: bar.tradeCount,
        lastMinuteMs: minuteMs,
      };
    } else {
      current.close = bar.close;
      if (highUnits > current.highUnits) current.highUnits = highUnits;
      if (lowUnits < current.lowUnits) current.lowUnits = lowUnits;
      current.volumeUnits += toUnits(bar.volume);
      current.tradeCount += bar.tradeCount;
      current.lastMinuteMs = minuteMs;
    }
  }

  if (current && current.lastMinuteMs === current.bucketStartMs + bucketMs - 60_000) {
    emit(current);
  }

  return result;
}

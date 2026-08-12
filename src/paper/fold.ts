import { aggregateBars } from '../backtest/aggregate.js';
import type { ClosedBar } from '../backtest/types.js';

// Incremental timeframe folding for the paper runner: raw 1m bars go
// in as they arrive, completed timeframe bars come out exactly once.
// Reuses aggregateBars so a paper session and a backtest at the same
// timeframe see byte-identical bars; the trailing-bucket proof rule
// there is what makes incremental use safe, because a bucket is only
// ever emitted once its period is proven over and re-aggregating a
// pending window can never re-emit or revise it.

export interface BarFolder {
  // Returns timeframe bars completed by this push, oldest first. Raw
  // bars at or before ones already pushed are ignored, so overlapping
  // fetches are safe.
  push(rawBars: readonly ClosedBar[]): ClosedBar[];
}

export function createBarFolder(
  timeframeMinutes: number,
  lastProcessedBar: string | null,
): BarFolder {
  const bucketMs = timeframeMinutes * 60_000;
  // Raw bars not yet part of an emitted bucket. Pruned as buckets
  // complete, so it never grows past the trailing unproven bucket.
  let pending: ClosedBar[] = [];
  let lastRawMs = -Infinity;
  let lastEmittedMs = lastProcessedBar === null ? -Infinity : Date.parse(lastProcessedBar);

  return {
    push(rawBars: readonly ClosedBar[]): ClosedBar[] {
      for (const bar of rawBars) {
        const ms = Date.parse(bar.bucketStart);
        if (ms <= lastRawMs) continue;
        pending.push(bar);
        lastRawMs = ms;
      }
      const completed = aggregateBars(pending, timeframeMinutes).filter(
        (bar) => Date.parse(bar.bucketStart) > lastEmittedMs,
      );
      const newest = completed[completed.length - 1];
      if (newest) {
        lastEmittedMs = Date.parse(newest.bucketStart);
        pending = pending.filter((bar) => Date.parse(bar.bucketStart) >= lastEmittedMs + bucketMs);
      }
      return completed;
    },
  };
}

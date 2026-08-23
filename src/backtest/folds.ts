import type { ClosedBar } from './types.js';

// Contiguous equal folds for walk-forward evaluation. When the bar
// count does not divide evenly, the remainder is dropped from the
// OLDEST end: the newest data is always scored, and the caller reports
// what was dropped instead of hiding it.

export interface FoldSplit {
  folds: ClosedBar[][];
  droppedOldest: number;
}

export function splitFolds(bars: readonly ClosedBar[], foldCount: number): FoldSplit {
  if (!Number.isInteger(foldCount) || foldCount < 2) {
    throw new Error('fold count must be an integer >= 2');
  }
  const size = Math.floor(bars.length / foldCount);
  if (size === 0) {
    throw new Error(`${bars.length} bars cannot fill ${foldCount} folds`);
  }
  const droppedOldest = bars.length - size * foldCount;
  const folds: ClosedBar[][] = [];
  for (let i = 0; i < foldCount; i += 1) {
    const start = droppedOldest + i * size;
    folds.push(bars.slice(start, start + size));
  }
  return { folds, droppedOldest };
}

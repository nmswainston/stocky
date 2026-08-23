import { describe, expect, it } from 'vitest';
import { splitFolds } from './folds.js';
import { specFromArgs } from './strategy-factory.js';
import { barsFromCloses } from './testing/fixtures.js';

describe('splitFolds', () => {
  const bars = barsFromCloses(Array.from({ length: 23 }, (_, i) => `${100 + i}`));

  it('rejects nonsense fold counts and starving splits', () => {
    expect(() => splitFolds(bars, 1)).toThrow();
    expect(() => splitFolds(bars.slice(0, 3), 4)).toThrow();
  });

  it('drops the remainder from the OLDEST end so the newest data is scored', () => {
    const { folds, droppedOldest } = splitFolds(bars, 4);
    expect(droppedOldest).toBe(3);
    expect(folds).toHaveLength(4);
    expect(folds.every((fold) => fold.length === 5)).toBe(true);
    // The last fold ends at the newest bar; the first dropped bars are the oldest.
    expect(folds[3]![4]!.close).toBe(bars[22]!.close);
    expect(folds[0]![0]!.close).toBe(bars[3]!.close);
  });

  it('keeps folds contiguous and ordered', () => {
    const { folds } = splitFolds(bars, 4);
    const flat = folds.flat();
    for (let i = 1; i < flat.length; i += 1) {
      expect(Date.parse(flat[i]!.bucketStart)).toBeGreaterThan(Date.parse(flat[i - 1]!.bucketStart));
    }
  });
});

describe('specFromArgs', () => {
  it('parses a strategy with its flags', () => {
    const args = new Map([['strategy', 'sma'], ['fast', '5'], ['slow', '20']]);
    expect(specFromArgs(args)).toEqual({ kind: 'sma', fast: 5, slow: 20 });
  });

  it('wraps with the volatility filter when asked', () => {
    const args = new Map([
      ['strategy', 'meanrev'],
      ['vol-filter', 'above'],
      ['vol-bps', '5'],
    ]);
    expect(specFromArgs(args)).toEqual({
      kind: 'volfiltered',
      mode: 'above',
      period: 20,
      thresholdBps: 5,
      inner: { kind: 'meanrev', period: 20, entryZ: 2, exitZ: 0.5 },
    });
  });

  it('rejects unknown strategies', () => {
    expect(() => specFromArgs(new Map([['strategy', 'hodl']]))).toThrow();
  });
});

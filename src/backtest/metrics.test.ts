import { describe, expect, it } from 'vitest';
import { maxDrawdown, missingBarCount, sharpeRatio, winStats } from './metrics.js';
import { bar } from './testing/fixtures.js';
import type { RoundTrip } from './types.js';

const times = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());

describe('maxDrawdown', () => {
  it('finds the deepest peak-to-trough drop and the longest underwater stretch', () => {
    const equity = [100, 120, 90, 95, 130, 110];
    const report = maxDrawdown(equity, times(6));
    // Deepest: 120 down to 90 is 25%.
    expect(report.maxDrawdownPct).toBeCloseTo(0.25, 10);
    // Longest underwater: peak at index 1, recovered at index 4.
    expect(report.duration).not.toBeNull();
    expect(report.duration!.bars).toBe(3);
    expect(report.duration!.from).toBe(times(6)[1]);
    expect(report.duration!.to).toBe(times(6)[4]);
  });

  it('measures an unrecovered drawdown to the final bar', () => {
    const equity = [100, 110, 105, 104, 103];
    const report = maxDrawdown(equity, times(5));
    expect(report.duration!.bars).toBe(3);
    expect(report.duration!.to).toBe(times(5)[4]);
  });

  it('reports zero for a monotonic climb', () => {
    const report = maxDrawdown([100, 101, 102], times(3));
    expect(report.maxDrawdownPct).toBe(0);
    expect(report.duration).toBeNull();
  });
});

describe('sharpeRatio', () => {
  it('is null when there is no variance or too little data', () => {
    expect(sharpeRatio([100, 100, 100, 100])).toBeNull();
    expect(sharpeRatio([100, 101])).toBeNull();
  });

  it('is positive for a steady climb with noise', () => {
    const equity = Array.from({ length: 100 }, (_, i) => 100 * 1.001 ** i + (i % 2) * 0.01);
    expect(sharpeRatio(equity)).toBeGreaterThan(0);
  });
});

describe('winStats', () => {
  const trip = (netPnlPct: number): RoundTrip => ({
    entry: {} as RoundTrip['entry'],
    exit: {} as RoundTrip['exit'],
    netPnl: '0',
    netPnlPct,
    holdingBars: 1,
  });

  it('is null with no round trips, not zero', () => {
    const stats = winStats([]);
    expect(stats.winRate).toBeNull();
    expect(stats.averageWinPct).toBeNull();
  });

  it('counts zero pnl as a loss because fees were paid for nothing', () => {
    const stats = winStats([trip(0.1), trip(0), trip(-0.05)]);
    expect(stats.winRate).toBeCloseTo(1 / 3, 10);
    expect(stats.averageWinPct).toBeCloseTo(0.1, 10);
    expect(stats.averageLossPct).toBeCloseTo(-0.025, 10);
  });
});

describe('missingBarCount', () => {
  it('reports gaps instead of hiding them', () => {
    const present = [bar(0, '100', '100'), bar(1, '100', '100'), bar(5, '100', '100')];
    expect(missingBarCount(present)).toBe(3);
    expect(missingBarCount(present.slice(0, 2))).toBe(0);
  });
});

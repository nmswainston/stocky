import { describe, expect, it } from 'vitest';
import { runReplay, zeroCosts } from './engine.js';
import { meanReversion, type MeanReversionState } from './strategies/mean-reversion.js';
import { barsFromCloses } from './testing/fixtures.js';
import { createBarWindow } from './window.js';
import type { BacktestConfig } from './types.js';

const config: BacktestConfig = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 0,
  makerFeeBps: 0,
  slippageBps: 0,
};

const decideOn = (
  closes: string[],
  strategy: ReturnType<typeof meanReversion>,
  prior: MeanReversionState | null = null,
) => {
  const bars = barsFromCloses(closes);
  return strategy.decide(createBarWindow(bars, bars.length), prior);
};

describe('meanReversion', () => {
  it('rejects nonsense parameters', () => {
    expect(() => meanReversion(1, 2, 0.5)).toThrow();
    expect(() => meanReversion(20, 0, 0)).toThrow();
    expect(() => meanReversion(20, 0.5, 2)).toThrow();
    expect(() => meanReversion(2.5, 2, 0.5)).toThrow();
  });

  it('enters below the entry threshold and shows hysteresis on exit', () => {
    const strategy = meanReversion(5, 1.8, 0.5);
    // Four flat closes then a plunge: mean 98, stdev 4, z = -2.0.
    const entered = decideOn(['100', '100', '100', '100', '90'], strategy);
    expect(entered.signal).toBe('long');
    expect(entered.state.holding).toBe(true);

    // Price snaps back above the mean: z positive, holding released.
    const exited = decideOn(['100', '100', '100', '90', '100'], strategy, entered.state);
    expect(exited.signal).toBe('flat');
    expect(exited.state.holding).toBe(false);

    // The same reverted window does NOT trigger a fresh entry.
    const fresh = decideOn(['100', '100', '100', '90', '100'], strategy, null);
    expect(fresh.signal).toBe('flat');
  });

  it('a z-score exactly at the threshold does not trade, exactly', () => {
    // Single-bar drop at period 5 yields z = -2 with no rounding: the
    // squared-bigint comparison is equality, and strict means no trade.
    // Float arithmetic could tip this either way; integers cannot.
    const atBoundary = meanReversion(5, 2, 0.5);
    const decision = decideOn(['100', '100', '100', '100', '90'], atBoundary);
    expect(decision.signal).toBe('flat');
    // One hundredth of a sigma shallower, and it trades.
    const justInside = meanReversion(5, 1.99, 0.5);
    expect(decideOn(['100', '100', '100', '100', '90'], justInside).signal).toBe('long');
  });

  it('a flat window never enters and releases a holding', () => {
    const strategy = meanReversion(5, 1.8, 0.5);
    const flat = ['100', '100', '100', '100', '100'];
    expect(decideOn(flat, strategy).signal).toBe('flat');
    expect(decideOn(flat, strategy, { holding: true }).signal).toBe('flat');
  });

  it('runs through the engine with warmup, purity checks, and a round trip', () => {
    const closes = [
      '100', '100', '100', '100', '100', '100',
      '90',
      '100', '100', '100',
    ];
    const strategy = meanReversion(5, 1.8, 0.5);
    const outcome = runReplay(strategy, barsFromCloses(closes), config, zeroCosts, {
      verifyDecisions: true,
    });
    // Decision on the plunge bar (index 6) fills at index 7's open;
    // reversion decision on index 7 sells at index 8's open.
    expect(outcome.fills).toHaveLength(2);
    expect(outcome.fills[0]!.side).toBe('BUY');
    expect(outcome.fills[0]!.executedAtBar).toBe(barsFromCloses(closes)[7]!.bucketStart);
    expect(outcome.fills[1]!.side).toBe('SELL');
    expect(outcome.fills[1]!.executedAtBar).toBe(barsFromCloses(closes)[8]!.bucketStart);
    expect(outcome.roundTrips).toHaveLength(1);
  });
});

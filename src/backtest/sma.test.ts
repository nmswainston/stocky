import { describe, expect, it } from 'vitest';
import { runReplay, zeroCosts } from './engine.js';
import { smaCrossover } from './strategies/sma-crossover.js';
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

describe('smaCrossover', () => {
  it('rejects nonsense periods', () => {
    expect(() => smaCrossover(0, 5)).toThrow();
    expect(() => smaCrossover(5, 5)).toThrow();
    expect(() => smaCrossover(2.5, 5)).toThrow();
  });

  it('signals long exactly when the fast average is above the slow average', () => {
    const strategy = smaCrossover(2, 3);
    // Closes 100, 100, 100: averages equal, not above, so flat.
    let bars = barsFromCloses(['100', '100', '100']);
    expect(strategy.decide(createBarWindow(bars, 3), null).signal).toBe('flat');
    // Closes 100, 100, 106: fast (100+106)/2 = 103, slow 102: long.
    bars = barsFromCloses(['100', '100', '106']);
    expect(strategy.decide(createBarWindow(bars, 3), null).signal).toBe('long');
    // Falling tail: fast below slow, flat.
    bars = barsFromCloses(['106', '100', '94']);
    expect(strategy.decide(createBarWindow(bars, 3), null).signal).toBe('flat');
  });

  it('decides on exact integer math where floats would waffle', () => {
    const strategy = smaCrossover(1, 3);
    // Fast = 0.30000000, slow = (0.1 + 0.2 + 0.3) / 3 = 0.2 exactly.
    // In floats, 0.1 + 0.2 pollutes the comparison; in units it is exact.
    const bars = barsFromCloses(['0.10000000', '0.20000000', '0.30000000']);
    const decision = strategy.decide(createBarWindow(bars, 3), null);
    expect(decision.signal).toBe('long');
    expect(decision.state.fastAboveSlow).toBe(true);
  });

  it('goes long through the engine only after warmup and a genuine cross', () => {
    // Flat then a strong ramp: the cross happens after the ramp begins.
    const closes = ['100', '100', '100', '100', '100', '100', '101', '103', '106', '110', '115'];
    const strategy = smaCrossover(2, 4);
    const outcome = runReplay(strategy, barsFromCloses(closes), config, zeroCosts, {
      verifyDecisions: true,
    });
    expect(outcome.fills.length).toBeGreaterThanOrEqual(1);
    const firstFill = outcome.fills[0]!;
    expect(firstFill.side).toBe('BUY');
    // Ramp starts at index 6; the fast SMA crosses at index 6 earliest,
    // and execution is at least one bar later than any decision.
    expect(Date.parse(firstFill.executedAtBar)).toBeGreaterThan(
      Date.parse(barsFromCloses(closes)[6]!.bucketStart),
    );
    expect(outcome.openPositionAtEnd).toBe(true);
  });
});

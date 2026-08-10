import { describe, expect, it } from 'vitest';
import { fromUnits, toUnits } from '../decimal.js';
import { basisPointCosts } from './costs.js';
import { runReplay } from './engine.js';
import { bar } from './testing/fixtures.js';
import type { BacktestConfig, Strategy } from './types.js';

const config: BacktestConfig = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 60,
  makerFeeBps: 40,
  slippageBps: 10,
};

const costs = basisPointCosts(config);

describe('fee and slippage math', () => {
  it('charges 60 bps on a round notional exactly', () => {
    expect(fromUnits(costs.fee(toUnits('10000')))).toBe('60.00000000');
  });

  it('rounds fees up, never down', () => {
    // 60 bps of 0.00000001 is a fraction of the smallest unit: still 1 unit.
    expect(costs.fee(1n)).toBe(1n);
  });

  it('moves fills against the trade direction', () => {
    const open = toUnits('50000');
    expect(costs.buyFillPrice(open)).toBeGreaterThan(open);
    expect(costs.sellFillPrice(open)).toBeLessThan(open);
    expect(fromUnits(costs.buyFillPrice(open))).toBe('50050.00000000');
    expect(fromUnits(costs.sellFillPrice(open))).toBe('49950.00000000');
  });
});

describe('fees inside the engine', () => {
  const alwaysLong: Strategy<Record<string, never>> = {
    name: 'always-long',
    warmupBars: 0,
    decide: () => ({ signal: 'long', state: {} }),
  };

  it('sizes an entry so notional plus fee fits the budget, fee on the slipped price', () => {
    const bars = [bar(0, '100', '100'), bar(1, '100', '100'), bar(2, '100', '100')];
    const outcome = runReplay(alwaysLong, bars, config, costs);
    expect(outcome.fills).toHaveLength(1);
    const fill = outcome.fills[0]!;
    // Slippage first: 10 bps is 0.1%, so 100 becomes 100.10, not 100.01.
    // That confusion is itself a classic fee modeling bug.
    expect(fill.fillPrice).toBe('100.10000000');
    const notional = toUnits(fill.notional);
    const fee = toUnits(fill.fee);
    // Fee is 60 bps of the post-slippage notional, rounded up.
    const expectedFee = (notional * 60n + 9_999n) / 10_000n;
    expect(fee).toBe(expectedFee);
    // The whole cost fits the initial cash, with only rounding dust left.
    const spent = notional + fee;
    expect(spent <= toUnits('10000')).toBe(true);
    expect(toUnits('10000') - spent < toUnits('101')).toBe(true);
  });

  it('flat price round trip loses exactly the friction', () => {
    const bars = [
      bar(0, '100', '100'),
      bar(1, '100', '100'),
      bar(2, '100', '100'),
      bar(3, '100', '100'),
    ];
    const oneRoundTrip: Strategy<Record<string, never>> = {
      name: 'one-round-trip',
      warmupBars: 0,
      decide: (window) => ({ signal: window.length === 1 ? 'long' : 'flat', state: {} }),
    };
    const outcome = runReplay(oneRoundTrip, bars, config, costs);
    expect(outcome.roundTrips).toHaveLength(1);
    const initial = toUnits('10000');
    const lost = initial - outcome.finalEquityUnits;
    // With the price pinned at 100, every unit of loss is friction.
    expect(lost).toBe(outcome.totalFeesUnits + outcome.totalSlippageUnits);
    expect(lost > 0n).toBe(true);
    // And gross, which strips friction from the same trades, is whole.
    expect(outcome.grossFinalEquityUnits).toBe(initial);
  });
});

import { describe, expect, it } from 'vitest';
import { runReplay, zeroCosts } from './engine.js';
import { buyAndHold } from './strategies/buy-and-hold.js';
import { meanReversion } from './strategies/mean-reversion.js';
import { volatilityFilter } from './strategies/volatility-filter.js';
import { barsFromCloses } from './testing/fixtures.js';
import { createBarWindow } from './window.js';
import type { BacktestConfig, Strategy } from './types.js';

const config: BacktestConfig = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 0,
  makerFeeBps: 0,
  slippageBps: 0,
};

const decideOn = (closes: string[], strategy: Strategy<unknown>, prior: unknown = null) => {
  const bars = barsFromCloses(closes);
  return strategy.decide(createBarWindow(bars, bars.length), prior as never);
};

// 3 one-bp moves on a 10000 base: about 1 bp average, decisively quiet.
const quiet = ['10000', '10001', '10000', '10001'];
// 3 one-percent moves: about 100 bps average, decisively lively.
const lively = ['10000', '10100', '10000', '10100'];

describe('volatilityFilter', () => {
  it('rejects nonsense parameters', () => {
    expect(() => volatilityFilter(buyAndHold, 'above', 1, 10)).toThrow();
    expect(() => volatilityFilter(buyAndHold, 'above', 20, 0)).toThrow();
    expect(() => volatilityFilter(buyAndHold, 'above', 20, 2.5)).toThrow();
  });

  it('gates an always-long inner by regime, in both modes', () => {
    const above = volatilityFilter(buyAndHold, 'above', 3, 10);
    expect(decideOn(quiet, above).signal).toBe('flat');
    expect(decideOn(lively, above).signal).toBe('long');

    const below = volatilityFilter(buyAndHold, 'below', 3, 10);
    expect(decideOn(quiet, below).signal).toBe('long');
    expect(decideOn(lively, below).signal).toBe('flat');
  });

  it('volatility exactly at the threshold counts as not above, exactly', () => {
    // One move of exactly 10 bps of the prior close, then flat closes:
    // movement * 10000 == threshold * priceMass, strict > fails.
    const boundary = ['10000', '10010', '10010', '10010'];
    const above = volatilityFilter(buyAndHold, 'above', 3, 10);
    expect(decideOn(boundary, above).signal).toBe('flat');
    const justBelowThreshold = volatilityFilter(buyAndHold, 'above', 3, 9);
    expect(decideOn(boundary, justBelowThreshold).signal).toBe('long');
  });

  it('keeps consulting the inner strategy while blocked, so its state lives on', () => {
    const inner = meanReversion(5, 1.8, 0.5);
    const filtered = volatilityFilter(inner, 'below', 5, 5_000);
    // The plunge is a huge move: filter (below mode) blocks the entry
    // signal, but the inner state must still record the stretch logic.
    const plunge = ['100', '100', '100', '100', '100', '90'];
    const decision = decideOn(plunge, filtered);
    expect(decision.signal).toBe('flat');
    expect((decision.state as { inner: unknown }).inner).toEqual({ holding: true });
  });

  it('through the engine: filtered churner trades only in the lively regime', () => {
    // 20 flat bars then 20 alternating one-percent bars.
    const closes = [
      ...Array.from({ length: 20 }, () => '10000'),
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '10100' : '10000')),
    ];
    const filtered = volatilityFilter(buyAndHold, 'above', 5, 20);
    const outcome = runReplay(filtered, barsFromCloses(closes), config, zeroCosts, {
      verifyDecisions: true,
    });
    expect(outcome.fills.length).toBeGreaterThan(0);
    // No fill may execute before the lively regime begins at bar 20.
    const regimeStart = barsFromCloses(closes)[20]!.bucketStart;
    for (const fill of outcome.fills) {
      expect(Date.parse(fill.executedAtBar)).toBeGreaterThan(Date.parse(regimeStart));
    }
  });
});

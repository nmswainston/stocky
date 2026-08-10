import { describe, expect, it } from 'vitest';
import { divUnitsDown, fromUnits, mulUnitsDown, mulUnitsUp, toUnits } from '../decimal.js';
import { runReplay, zeroCosts } from './engine.js';
import { bar, barsFromCloses } from './testing/fixtures.js';
import type { BacktestConfig, ClosedBar, Strategy } from './types.js';

const config: BacktestConfig = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 0,
  makerFeeBps: 0,
  slippageBps: 0,
};

const alwaysLong: Strategy<Record<string, never>> = {
  name: 'always-long',
  warmupBars: 0,
  decide: () => ({ signal: 'long', state: {} }),
};

describe('no look-ahead', () => {
  it('a decision executes at the next bar open, verified by hand', () => {
    // b0 close 100, b1 opens 100 closes 110, b2 opens 120 closes 120.
    const bars = [bar(0, '100', '100'), bar(1, '100', '110'), bar(2, '120', '120')];
    const outcome = runReplay(alwaysLong, bars, config, zeroCosts);
    // Decision on b0 fills at b1.open = 100: quantity 100 with no fees.
    expect(outcome.fills).toHaveLength(1);
    const fill = outcome.fills[0]!;
    expect(fill.decidedAtBar).toBe(bars[0]!.bucketStart);
    expect(fill.executedAtBar).toBe(bars[1]!.bucketStart);
    expect(fill.fillPrice).toBe('100.00000000');
    expect(fill.quantity).toBe('100.00000000');
    // Equity marks: 10000, then 100 * 110, then 100 * 120.
    expect(outcome.equityCurve.map((p) => p.equity)).toEqual([
      '10000.00000000',
      '11000.00000000',
      '12000.00000000',
    ]);
  });

  it('every fill in a realistic run happened strictly after its decision', () => {
    const closes = Array.from({ length: 120 }, (_, i) =>
      (100 + 10 * Math.sin(i / 5) + (i % 7)).toFixed(2),
    );
    const zigzag: Strategy<Record<string, never>> = {
      name: 'zigzag',
      warmupBars: 0,
      decide: (window) => ({
        signal: window.length % 2 === 0 ? 'long' : 'flat',
        state: {},
      }),
    };
    const outcome = runReplay(zigzag, barsFromCloses(closes), config, zeroCosts);
    expect(outcome.fills.length).toBeGreaterThan(10);
    for (const fill of outcome.fills) {
      expect(Date.parse(fill.executedAtBar)).toBeGreaterThan(Date.parse(fill.decidedAtBar));
    }
  });

  it('a signal on the final bar never executes', () => {
    const bars = barsFromCloses(['100', '101', '102']);
    const lastBarTime = bars[bars.length - 1]!.bucketStart;
    const lastMinuteSniper: Strategy<Record<string, never>> = {
      name: 'last-minute-sniper',
      warmupBars: 0,
      decide: (window) => ({
        signal: window.last.bucketStart === lastBarTime ? 'long' : 'flat',
        state: {},
      }),
    };
    const outcome = runReplay(lastMinuteSniper, bars, config, zeroCosts);
    expect(outcome.fills).toHaveLength(0);
    expect(outcome.undecidedSignalAtEnd).toBe(true);
    expect(outcome.finalEquityUnits).toBe(toUnits('10000'));
  });

  it('perfect intrabar knowledge earns exactly next-open execution, nothing more', () => {
    // The clairvoyant longs whenever the bar it just saw closed up. If any
    // same-bar price leaked into execution this would beat the reference.
    const bars: ClosedBar[] = [
      bar(0, '100', '104'),
      bar(1, '106', '103'),
      bar(2, '101', '108'),
      bar(3, '110', '109'),
      bar(4, '107', '112'),
      bar(5, '113', '111'),
    ];
    const clairvoyant: Strategy<Record<string, never>> = {
      name: 'clairvoyant',
      warmupBars: 0,
      decide: (window) => ({
        signal: Number(window.last.close) > Number(window.last.open) ? 'long' : 'flat',
        state: {},
      }),
    };
    const outcome = runReplay(clairvoyant, bars, config, zeroCosts);

    // Independent reference: replay the same rule filling at the NEXT open
    // with the same rounding rules.
    let cash = toUnits('10000');
    let position = 0n;
    let wantLong = false;
    for (let i = 0; i < bars.length; i += 1) {
      const b = bars[i]!;
      const open = toUnits(b.open);
      if (wantLong && position === 0n) {
        position = divUnitsDown(cash, open);
        cash -= mulUnitsUp(position, open);
      } else if (!wantLong && position > 0n) {
        cash += mulUnitsDown(position, open);
        position = 0n;
      }
      wantLong = Number(b.close) > Number(b.open);
    }
    const reference = cash + mulUnitsDown(position, toUnits(bars[bars.length - 1]!.close));
    expect(outcome.finalEquityUnits).toBe(reference);

    // Sanity check on the test itself: cheating (same bar close fills)
    // would have produced a different number on this data.
    let cheatCash = toUnits('10000');
    let cheatPosition = 0n;
    for (const b of bars) {
      const close = toUnits(b.close);
      const up = Number(b.close) > Number(b.open);
      if (up && cheatPosition === 0n) {
        cheatPosition = divUnitsDown(cheatCash, close);
        cheatCash -= mulUnitsUp(cheatPosition, close);
      } else if (!up && cheatPosition > 0n) {
        cheatCash += mulUnitsDown(cheatPosition, close);
        cheatPosition = 0n;
      }
    }
    const cheat = cheatCash + mulUnitsDown(cheatPosition, toUnits(bars[bars.length - 1]!.close));
    expect(cheat).not.toBe(reference);
  });
});

describe('purity enforcement', () => {
  const bars = barsFromCloses(['100', '101', '102', '103']);

  it('rejects a nondeterministic strategy', () => {
    let calls = 0;
    const flipFlopper: Strategy<Record<string, never>> = {
      name: 'flip-flopper',
      warmupBars: 0,
      decide: () => {
        calls += 1;
        return { signal: calls % 2 === 0 ? 'long' : 'flat', state: {} };
      },
    };
    expect(() => runReplay(flipFlopper, bars, config, zeroCosts, { verifyDecisions: true }))
      .toThrow(/not deterministic/);
  });

  it('rejects a strategy that mutates its prior state', () => {
    const mutator: Strategy<{ count: number }> = {
      name: 'mutator',
      warmupBars: 0,
      decide: (_window, prior) => {
        if (prior) prior.count = 999;
        return { signal: 'flat', state: { count: (prior?.count ?? 0) + 1 } };
      },
    };
    expect(() => runReplay(mutator, bars, config, zeroCosts, { verifyDecisions: true }))
      .toThrow(/mutated its prior state/);
  });

  it('accepts an honest strategy under the same scrutiny', () => {
    const outcome = runReplay(alwaysLong, bars, config, zeroCosts, { verifyDecisions: true });
    expect(outcome.fills).toHaveLength(1);
  });
});

describe('warmup', () => {
  it('holds signals flat until the window is warm', () => {
    const bars = barsFromCloses(['100', '101', '102', '103', '104', '105']);
    const warmupThree: Strategy<Record<string, never>> = {
      name: 'warm',
      warmupBars: 3,
      decide: () => ({ signal: 'long', state: {} }),
    };
    const outcome = runReplay(warmupThree, bars, config, zeroCosts);
    // First warm decision is on bar index 2, so the fill is at bar index 3.
    expect(outcome.fills[0]!.executedAtBar).toBe(bars[3]!.bucketStart);
    expect(outcome.warmupBarsExcluded).toBe(2);
  });
});

describe('accounting invariants', () => {
  it('cash never goes negative and equity is conserved under zero costs', () => {
    const closes = Array.from({ length: 200 }, (_, i) => (100 + Math.sin(i / 3) * 20).toFixed(2));
    const churner: Strategy<Record<string, never>> = {
      name: 'churner',
      warmupBars: 0,
      decide: (window) => ({ signal: window.length % 3 === 0 ? 'long' : 'flat', state: {} }),
    };
    const outcome = runReplay(churner, barsFromCloses(closes), config, zeroCosts);
    // Zero friction round trips at continuous prices: gross equals net.
    expect(outcome.grossFinalEquityUnits).toBe(outcome.finalEquityUnits);
    expect(outcome.totalFeesUnits).toBe(0n);
    expect(outcome.totalSlippageUnits).toBe(0n);
    for (const point of outcome.equityCurve) {
      expect(Number(fromUnits(toUnits(point.equity)))).toBeGreaterThan(0);
    }
  });
});

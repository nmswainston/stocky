import { describe, expect, it } from 'vitest';
import { basisPointCosts } from '../backtest/costs.js';
import { runReplay } from '../backtest/engine.js';
import { smaCrossover } from '../backtest/strategies/sma-crossover.js';
import { barsFromCloses } from '../backtest/testing/fixtures.js';
import type { BacktestConfig, ClosedBar } from '../backtest/types.js';
import {
  createBook,
  deserializeBook,
  serializeBook,
  stepBook,
  type BookState,
} from './session.js';

const config: BacktestConfig = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 60,
  makerFeeBps: 40,
  slippageBps: 10,
};

const costs = basisPointCosts(config);
const fractionBps = 10_000n;

const closes = Array.from({ length: 90 }, (_, i) =>
  (100 + 15 * Math.sin(i / 7) + (i % 5)).toFixed(2),
);
const bars = barsFromCloses(closes);

function foldBars(
  initial: BookState<unknown>,
  history: readonly ClosedBar[],
  fromIndex: number,
): BookState<unknown> {
  const strategy = smaCrossover(3, 8);
  let book = initial;
  for (let i = fromIndex; i < history.length; i += 1) {
    book = stepBook(book, strategy, history.slice(0, i + 1), costs, fractionBps);
  }
  return book;
}

describe('paper session equals backtest', () => {
  it('produces bit-identical fills and equity to runReplay on the same bars', () => {
    const outcome = runReplay(smaCrossover(3, 8), bars, config, costs);
    const book = foldBars(createBook(config.initialEquity), bars, 0);

    expect(book.fills).toEqual(outcome.fills);
    expect(book.equityCurve).toEqual(outcome.equityCurve);
    const lastEquity = book.equityCurve[book.equityCurve.length - 1]!.equity;
    const engineLast = outcome.equityCurve[outcome.equityCurve.length - 1]!.equity;
    expect(lastEquity).toBe(engineLast);
  });
});

describe('crash recovery by replay', () => {
  it('resume after serialize round trip is identical to never crashing', () => {
    const uninterrupted = foldBars(createBook(config.initialEquity), bars, 0);

    // Crash after bar 40: serialize, "restart", deserialize, catch up.
    let book = foldBars(createBook(config.initialEquity), bars.slice(0, 41), 0);
    book = deserializeBook(serializeBook(book));
    const resumed = foldBars(book, bars, 41);

    expect(serializeBook(resumed)).toEqual(serializeBook(uninterrupted));
  });

  it('serialization round trips exactly', () => {
    const book = foldBars(createBook(config.initialEquity), bars.slice(0, 30), 0);
    const roundTripped = deserializeBook(serializeBook(book));
    expect(roundTripped.cashUnits).toBe(book.cashUnits);
    expect(roundTripped.positionUnits).toBe(book.positionUnits);
    expect(roundTripped.pending).toEqual(book.pending);
  });
});

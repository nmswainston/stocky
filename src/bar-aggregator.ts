import { fromUnits, toUnits } from './decimal.js';
import type { Trade } from './parse.js';

// Pure streaming aggregation of trades into fixed-interval OHLCV bars.
// No clocks and no IO: callers pass time in and receive finalized bars
// back. State is treated as immutable; every operation returns a new map.

export interface Bar {
  symbol: string;
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradeCount: number;
}

interface Accumulator {
  bucketStartMs: number;
  openUnits: bigint;
  highUnits: bigint;
  lowUnits: bigint;
  closeUnits: bigint;
  volumeUnits: bigint;
  tradeCount: number;
}

export type AggregatorState = ReadonlyMap<string, Accumulator>;

export function emptyState(): AggregatorState {
  return new Map();
}

export function bucketStartMsOf(exchangeTime: string, bucketMs: number): number {
  return Math.floor(Date.parse(exchangeTime) / bucketMs) * bucketMs;
}

function toBar(symbol: string, accumulator: Accumulator): Bar {
  return {
    symbol,
    bucketStart: new Date(accumulator.bucketStartMs).toISOString(),
    open: fromUnits(accumulator.openUnits),
    high: fromUnits(accumulator.highUnits),
    low: fromUnits(accumulator.lowUnits),
    close: fromUnits(accumulator.closeUnits),
    volume: fromUnits(accumulator.volumeUnits),
    tradeCount: accumulator.tradeCount,
  };
}

export interface ApplyResult {
  state: AggregatorState;
  finalized: Bar[];
  // True when the trade belongs to a bucket that was already finalized.
  // Such trades are preserved in raw storage but excluded from bars.
  late: boolean;
}

export function applyTrade(state: AggregatorState, trade: Trade, bucketMs: number): ApplyResult {
  const bucketStartMs = bucketStartMsOf(trade.exchangeTime, bucketMs);
  const priceUnits = toUnits(trade.price);
  const sizeUnits = toUnits(trade.size);
  const current = state.get(trade.symbol);

  if (current && bucketStartMs < current.bucketStartMs) {
    return { state, finalized: [], late: true };
  }

  const next = new Map(state);
  const finalized: Bar[] = [];

  if (current && bucketStartMs === current.bucketStartMs) {
    next.set(trade.symbol, {
      bucketStartMs,
      openUnits: current.openUnits,
      highUnits: priceUnits > current.highUnits ? priceUnits : current.highUnits,
      lowUnits: priceUnits < current.lowUnits ? priceUnits : current.lowUnits,
      closeUnits: priceUnits,
      volumeUnits: current.volumeUnits + sizeUnits,
      tradeCount: current.tradeCount + 1,
    });
  } else {
    if (current) finalized.push(toBar(trade.symbol, current));
    next.set(trade.symbol, {
      bucketStartMs,
      openUnits: priceUnits,
      highUnits: priceUnits,
      lowUnits: priceUnits,
      closeUnits: priceUnits,
      volumeUnits: sizeUnits,
      tradeCount: 1,
    });
  }

  return { state: next, finalized, late: false };
}

// Finalizes buckets whose window ended more than graceMs before nowMs.
// This closes bars for symbols that simply stopped trading.
export function finalizeStale(
  state: AggregatorState,
  nowMs: number,
  bucketMs: number,
  graceMs: number,
): { state: AggregatorState; finalized: Bar[] } {
  const finalized: Bar[] = [];
  const next = new Map(state);
  for (const [symbol, accumulator] of state) {
    if (accumulator.bucketStartMs + bucketMs + graceMs <= nowMs) {
      finalized.push(toBar(symbol, accumulator));
      next.delete(symbol);
    }
  }
  return { state: finalized.length > 0 ? next : state, finalized };
}

// Finalizes everything, including in-progress buckets. Used at shutdown so
// partial bars are persisted; on restart they are rebuilt from raw trades.
export function finalizeAll(state: AggregatorState): { state: AggregatorState; finalized: Bar[] } {
  const finalized: Bar[] = [];
  for (const [symbol, accumulator] of state) {
    finalized.push(toBar(symbol, accumulator));
  }
  return { state: emptyState(), finalized };
}

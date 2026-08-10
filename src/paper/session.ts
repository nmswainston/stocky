import { fromUnits, mulUnitsDown, toUnits } from '../decimal.js';
import { executeBuy, executeSell, type CostModel } from '../backtest/fills.js';
import { createBarWindow } from '../backtest/window.js';
import type { ClosedBar, Fill, Signal, Strategy } from '../backtest/types.js';

// One paper trading book, advanced one closed bar at a time. stepBook is
// the backtest loop body reshaped as a pure fold step: same settle,
// mark, decide, queue order, same shared fill code, so a paper session
// over the same bars produces bit-identical fills to a backtest. That
// identity is pinned by tests, and it is also what makes crash recovery
// trivial: resuming is just re-folding the bars that arrived while down.

export interface BookState<State> {
  cashUnits: bigint;
  positionUnits: bigint;
  pending: { target: Signal; decidedAtBar: string } | null;
  strategyState: State | null;
  fills: readonly Fill[];
  equityCurve: ReadonlyArray<{ time: string; equity: string }>;
}

export function createBook<State>(initialEquity: string): BookState<State> {
  return {
    cashUnits: toUnits(initialEquity),
    positionUnits: 0n,
    pending: null,
    strategyState: null,
    fills: [],
    equityCurve: [],
  };
}

// history must end with the bar being processed and start at the
// session's first bar, so window.length doubles as bars-since-start
// for the warmup gate, exactly as in the engine.
export function stepBook<State>(
  book: BookState<State>,
  strategy: Strategy<State>,
  history: readonly ClosedBar[],
  costs: CostModel,
  fractionBps: bigint,
): BookState<State> {
  const bar = history[history.length - 1];
  if (!bar) throw new Error('stepBook needs at least one bar');
  const openUnits = toUnits(bar.open);

  let { cashUnits, positionUnits } = book;
  const newFills: Fill[] = [];

  // 1. settle
  if (book.pending) {
    const site = {
      executedAtBar: bar.bucketStart,
      decidedAtBar: book.pending.decidedAtBar,
      referenceOpen: bar.open,
      openUnits,
    };
    if (book.pending.target === 'long' && positionUnits === 0n) {
      const buy = executeBuy(cashUnits, fractionBps, site, costs);
      if (buy) {
        cashUnits -= buy.spentUnits;
        positionUnits += buy.quantityUnits;
        newFills.push(buy.fill);
      }
    } else if (book.pending.target === 'flat' && positionUnits > 0n) {
      const sell = executeSell(positionUnits, site, costs);
      cashUnits += sell.proceedsUnits;
      positionUnits = 0n;
      newFills.push(sell.fill);
    }
  }

  // 2. mark
  const equityUnits = cashUnits + mulUnitsDown(positionUnits, toUnits(bar.close));

  // 3. decide, always under the purity check: live money may be fake
  // here, but an impure strategy should die in paper, not in phase 5.
  const window = createBarWindow(history, history.length);
  const pristine =
    book.strategyState === null ? null : structuredClone(book.strategyState);
  const decision = strategy.decide(window, book.strategyState);
  if (JSON.stringify(book.strategyState) !== JSON.stringify(pristine)) {
    throw new Error(`strategy ${strategy.name} mutated its prior state at ${bar.bucketStart}`);
  }
  const replay = strategy.decide(window, pristine);
  if (JSON.stringify(replay) !== JSON.stringify(decision)) {
    throw new Error(`strategy ${strategy.name} is not deterministic at ${bar.bucketStart}`);
  }

  const warm = history.length >= strategy.warmupBars;
  const target: Signal = warm ? decision.signal : 'flat';

  // 4. queue
  const isLong = positionUnits > 0n;
  const pending =
    (target === 'long') !== isLong ? { target, decidedAtBar: bar.bucketStart } : null;

  return {
    cashUnits,
    positionUnits,
    pending,
    strategyState: decision.state,
    fills: newFills.length > 0 ? [...book.fills, ...newFills] : book.fills,
    equityCurve: [...book.equityCurve, { time: bar.bucketStart, equity: fromUnits(equityUnits) }],
  };
}

// JSON-safe form for the state file. Units become decimal strings.
export interface SerializedBook {
  cash: string;
  position: string;
  pending: { target: Signal; decidedAtBar: string } | null;
  strategyState: unknown;
  fills: readonly Fill[];
  equityCurve: ReadonlyArray<{ time: string; equity: string }>;
}

export function serializeBook<State>(book: BookState<State>): SerializedBook {
  return {
    cash: fromUnits(book.cashUnits),
    position: fromUnits(book.positionUnits),
    pending: book.pending,
    strategyState: book.strategyState,
    fills: book.fills,
    equityCurve: book.equityCurve,
  };
}

export function deserializeBook<State>(serialized: SerializedBook): BookState<State> {
  return {
    cashUnits: toUnits(serialized.cash),
    positionUnits: toUnits(serialized.position),
    pending: serialized.pending,
    strategyState: (serialized.strategyState ?? null) as State | null,
    fills: serialized.fills,
    equityCurve: serialized.equityCurve,
  };
}

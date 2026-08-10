import { fromUnits, mulUnitsDown, toUnits } from '../decimal.js';
import { executeBuy, executeSell, type CostModel } from './fills.js';
import { createBarWindow } from './window.js';
import type {
  BacktestConfig,
  ClosedBar,
  Fill,
  RoundTrip,
  Signal,
  Strategy,
} from './types.js';

// Re-exported so engine consumers keep one import site for cost models.
export { zeroCosts, type CostModel } from './fills.js';

// The replay loop. Look-ahead is prevented by the shape of this loop,
// not by discipline inside strategies:
//
//   for each bar B:
//     1. settle: fill the pending signal, if any, at B.open
//     2. mark:   record equity at B.close
//     3. decide: strategy sees a window ending at B, returns a Signal
//     4. queue:  the signal becomes the pending signal, nothing more
//
// The decision made in step 3 carries no price and is not executable
// until step 1 of the NEXT iteration, so the earliest price it can touch
// is the open of a bar the strategy has never seen. Fills are constructed
// in exactly one place, inside settle. A signal on the final bar has no
// next open and is reported as undecidedSignalAtEnd instead of executing.

export interface ReplayOptions {
  // Runs every decision twice on structurally cloned state and rejects
  // the run if the outputs differ. Catches impure strategies in tests.
  verifyDecisions?: boolean;
}

export interface ReplayOutcome {
  equityCurve: Array<{ time: string; equity: string }>;
  fills: Fill[];
  roundTrips: RoundTrip[];
  finalEquityUnits: bigint;
  grossFinalEquityUnits: bigint;
  totalFeesUnits: bigint;
  totalSlippageUnits: bigint;
  openPositionAtEnd: boolean;
  undecidedSignalAtEnd: boolean;
  warmupBarsExcluded: number;
}

interface PendingSignal {
  target: Signal;
  decidedAtIndex: number;
}

export function runReplay<State>(
  strategy: Strategy<State>,
  bars: readonly ClosedBar[],
  config: BacktestConfig,
  costs: CostModel,
  options: ReplayOptions = {},
): ReplayOutcome {
  if (bars.length === 0) throw new Error('cannot backtest zero bars');
  if (config.positionFraction <= 0 || config.positionFraction > 1) {
    throw new Error('positionFraction must be in (0, 1]');
  }

  let cashUnits = toUnits(config.initialEquity);
  let positionUnits = 0n;
  // Cash flows revalued at raw opens with no fees. Same quantities, no
  // friction: the exact meaning of "gross" in the results.
  let grossCashUnits = cashUnits;

  let pending: PendingSignal | null = null;
  let state: State | null = null;
  let entry: { fill: Fill; index: number; costUnits: bigint } | null = null;

  const equityCurve: Array<{ time: string; equity: string }> = [];
  const fills: Fill[] = [];
  const roundTrips: RoundTrip[] = [];
  let totalFeesUnits = 0n;
  let totalSlippageUnits = 0n;

  // Position fraction as an exact ratio in ten-thousandths.
  const fractionBps = BigInt(Math.round(config.positionFraction * 10_000));

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index] as ClosedBar;
    const openUnits = toUnits(bar.open);

    // 1. settle
    if (pending) {
      const decidedAtBar = (bars[pending.decidedAtIndex] as ClosedBar).bucketStart;
      const site = {
        executedAtBar: bar.bucketStart,
        decidedAtBar,
        referenceOpen: bar.open,
        openUnits,
      };
      if (pending.target === 'long' && positionUnits === 0n) {
        const buy = executeBuy(cashUnits, fractionBps, site, costs);
        if (buy) {
          cashUnits -= buy.spentUnits;
          positionUnits += buy.quantityUnits;
          grossCashUnits -= buy.grossNotionalUnits;
          totalFeesUnits += buy.feeUnits;
          totalSlippageUnits += buy.slippageUnits;
          fills.push(buy.fill);
          entry = { fill: buy.fill, index, costUnits: buy.spentUnits };
        }
      } else if (pending.target === 'flat' && positionUnits > 0n) {
        const sell = executeSell(positionUnits, site, costs);
        cashUnits += sell.proceedsUnits;
        positionUnits = 0n;
        grossCashUnits += sell.grossNotionalUnits;
        totalFeesUnits += sell.feeUnits;
        totalSlippageUnits += sell.slippageUnits;
        fills.push(sell.fill);
        if (entry) {
          const pnlUnits = sell.proceedsUnits - entry.costUnits;
          roundTrips.push({
            entry: entry.fill,
            exit: sell.fill,
            netPnl: fromUnits(pnlUnits),
            netPnlPct: Number(pnlUnits) / Number(entry.costUnits),
            holdingBars: index - entry.index,
          });
          entry = null;
        }
      }
      pending = null;
    }

    // 2. mark
    const closeUnits = toUnits(bar.close);
    const equityUnits = cashUnits + mulUnitsDown(positionUnits, closeUnits);
    equityCurve.push({ time: bar.bucketStart, equity: fromUnits(equityUnits) });

    // 3. decide
    const window = createBarWindow(bars, index + 1);
    let decision;
    if (options.verifyDecisions) {
      // Clone before the first call so both mutation of prior state and
      // nondeterminism (clock, randomness, hidden counters) are caught.
      const pristine = state === null ? null : structuredClone(state);
      decision = strategy.decide(window, state);
      if (JSON.stringify(state) !== JSON.stringify(pristine)) {
        throw new Error(
          `strategy ${strategy.name} mutated its prior state at bar ${bar.bucketStart}`,
        );
      }
      const replay = strategy.decide(window, pristine);
      if (JSON.stringify(replay) !== JSON.stringify(decision)) {
        throw new Error(
          `strategy ${strategy.name} is not deterministic: repeated decision at bar ${bar.bucketStart} differed`,
        );
      }
    } else {
      decision = strategy.decide(window, state);
    }
    state = decision.state;
    const warm = index + 1 >= strategy.warmupBars;
    const target: Signal = warm ? decision.signal : 'flat';

    // 4. queue, only when the target differs from the current position
    const isLong = positionUnits > 0n;
    pending = (target === 'long') !== isLong ? { target, decidedAtIndex: index } : null;
  }

  const lastCloseUnits = toUnits((bars[bars.length - 1] as ClosedBar).close);
  return {
    equityCurve,
    fills,
    roundTrips,
    finalEquityUnits: cashUnits + mulUnitsDown(positionUnits, lastCloseUnits),
    grossFinalEquityUnits: grossCashUnits + mulUnitsDown(positionUnits, lastCloseUnits),
    totalFeesUnits,
    totalSlippageUnits,
    openPositionAtEnd: positionUnits > 0n,
    undecidedSignalAtEnd: pending !== null,
    warmupBarsExcluded: Math.min(Math.max(strategy.warmupBars - 1, 0), bars.length),
  };
}

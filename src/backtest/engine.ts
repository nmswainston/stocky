import { ONE, divUnitsDown, fromUnits, mulUnitsDown, mulUnitsUp, toUnits } from '../decimal.js';
import { createBarWindow } from './window.js';
import type {
  BacktestConfig,
  ClosedBar,
  Fill,
  RoundTrip,
  Signal,
  Strategy,
} from './types.js';

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

export interface CostModel {
  buyFillPrice(referenceOpenUnits: bigint): bigint;
  sellFillPrice(referenceOpenUnits: bigint): bigint;
  fee(notionalUnits: bigint): bigint;
}

export const zeroCosts: CostModel = {
  buyFillPrice: (price) => price,
  sellFillPrice: (price) => price,
  fee: () => 0n,
};

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
      if (pending.target === 'long' && positionUnits === 0n) {
        const fillPriceUnits = costs.buyFillPrice(openUnits);
        const budget = (cashUnits * fractionBps) / 10_000n;
        // Size so that notional plus its fee fits the budget. Probing the
        // fee on 1.0 of notional gives the fee rate without assuming the
        // model is basis points; the decrement loop then only absorbs
        // rounding, one or two iterations at most.
        const feePerOne = costs.fee(ONE);
        const notionalTarget = (budget * ONE) / (ONE + feePerOne);
        let quantityUnits = divUnitsDown(notionalTarget, fillPriceUnits);
        let notionalUnits = mulUnitsUp(quantityUnits, fillPriceUnits);
        let feeUnits = costs.fee(notionalUnits);
        while (quantityUnits > 0n && notionalUnits + feeUnits > budget) {
          quantityUnits -= 1n;
          notionalUnits = mulUnitsUp(quantityUnits, fillPriceUnits);
          feeUnits = costs.fee(notionalUnits);
        }
        if (quantityUnits > 0n) {
          cashUnits -= notionalUnits + feeUnits;
          positionUnits += quantityUnits;
          grossCashUnits -= mulUnitsUp(quantityUnits, openUnits);
          totalFeesUnits += feeUnits;
          totalSlippageUnits += mulUnitsUp(quantityUnits, fillPriceUnits - openUnits);
          const fill: Fill = {
            side: 'BUY',
            executedAtBar: bar.bucketStart,
            decidedAtBar,
            referenceOpen: bar.open,
            fillPrice: fromUnits(fillPriceUnits),
            quantity: fromUnits(quantityUnits),
            notional: fromUnits(notionalUnits),
            fee: fromUnits(feeUnits),
          };
          fills.push(fill);
          entry = { fill, index, costUnits: notionalUnits + feeUnits };
        }
      } else if (pending.target === 'flat' && positionUnits > 0n) {
        const fillPriceUnits = costs.sellFillPrice(openUnits);
        const quantityUnits = positionUnits;
        const notionalUnits = mulUnitsDown(quantityUnits, fillPriceUnits);
        const feeUnits = costs.fee(notionalUnits);
        cashUnits += notionalUnits - feeUnits;
        positionUnits = 0n;
        grossCashUnits += mulUnitsDown(quantityUnits, openUnits);
        totalFeesUnits += feeUnits;
        totalSlippageUnits += mulUnitsDown(quantityUnits, openUnits - fillPriceUnits);
        const fill: Fill = {
          side: 'SELL',
          executedAtBar: bar.bucketStart,
          decidedAtBar,
          referenceOpen: bar.open,
          fillPrice: fromUnits(fillPriceUnits),
          quantity: fromUnits(quantityUnits),
          notional: fromUnits(notionalUnits),
          fee: fromUnits(feeUnits),
        };
        fills.push(fill);
        if (entry) {
          const proceedsUnits = notionalUnits - feeUnits;
          const pnlUnits = proceedsUnits - entry.costUnits;
          roundTrips.push({
            entry: entry.fill,
            exit: fill,
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
    const decision = strategy.decide(window, state);
    if (options.verifyDecisions) {
      const replay = strategy.decide(window, state === null ? null : structuredClone(state));
      if (JSON.stringify(replay) !== JSON.stringify(decision)) {
        throw new Error(
          `strategy ${strategy.name} is not deterministic: repeated decision at bar ${bar.bucketStart} differed`,
        );
      }
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

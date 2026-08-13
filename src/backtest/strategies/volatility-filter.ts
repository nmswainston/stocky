import { toUnits } from '../../decimal.js';
import type { Strategy, StrategyDecision } from '../types.js';

// A combinator, not a strategy: wraps any inner strategy and gates its
// signals on recent realized volatility. mode 'above' only trades in
// lively markets (where mean reversion has stretches to revert), mode
// 'below' only in quiet ones (where trend followers churn less).
//
// Volatility here is total absolute bar-to-bar movement over total
// price mass across the window, in basis points:
//   vol_bps = 10000 * sum(|close_i - close_{i-1}|) / sum(close_{i-1})
// The comparison stays in exact bigints: no division ever happens,
//   sum(|dc|) * 10000  vs  thresholdBps * sum(prev closes).
//
// The inner strategy is ALWAYS consulted so its state keeps evolving;
// only its signal is overridden to flat when the filter blocks. A
// blocked filter therefore exits open positions rather than freezing
// them, which is the conservative reading of "do not trade here".

export interface VolatilityFilterState<InnerState> {
  inner: InnerState | null;
}

export function volatilityFilter<InnerState>(
  inner: Strategy<InnerState>,
  mode: 'above' | 'below',
  period: number,
  thresholdBps: number,
): Strategy<VolatilityFilterState<InnerState>> {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error('volatility period must be an integer >= 2');
  }
  if (!Number.isInteger(thresholdBps) || thresholdBps < 1) {
    throw new Error('volatility threshold must be a positive integer of basis points');
  }
  const threshold = BigInt(thresholdBps);

  return {
    name: `vol-${mode}(${period}/${thresholdBps}bps)+${inner.name}`,
    warmupBars: Math.max(inner.warmupBars, period + 1),
    decide: (window, prior): StrategyDecision<VolatilityFilterState<InnerState>> => {
      const innerDecision = inner.decide(window, prior?.inner ?? null);

      // period returns need period + 1 closes.
      const count = Math.min(period + 1, window.length);
      const closes = window.lastN(count).map((bar) => toUnits(bar.close));
      let movement = 0n;
      let priceMass = 0n;
      for (let i = 1; i < closes.length; i += 1) {
        const change = (closes[i] as bigint) - (closes[i - 1] as bigint);
        movement += change < 0n ? -change : change;
        priceMass += closes[i - 1] as bigint;
      }
      const lively = movement * 10_000n > threshold * priceMass;
      const open = mode === 'above' ? lively : !lively;

      return {
        signal: open ? innerDecision.signal : 'flat',
        state: { inner: innerDecision.state },
      };
    },
  };
}

import { addBpsUp, bpsOfUp, subtractBpsDown } from '../decimal.js';
import type { BacktestConfig } from './types.js';
import type { CostModel } from './engine.js';

// Fees and slippage as basis points, every rounding against the trader.
//
// Fee modeling errors this avoids, called out explicitly:
// - Fees are charged on notional at the actual fill price, after
//   slippage, not on the frictionless reference price.
// - Fees apply to both entry and exit. Forgetting the exit fee roughly
//   halves apparent costs.
// - Every fill in this phase is a taker fill because target-position
//   signals cross the spread immediately. makerFeeBps exists in the
//   config but charging it here would flatter the results; it becomes
//   relevant only when limit orders exist.
// - Slippage is directional: buys fill above the open, sells below it.
//   Modeling it as a symmetric fee-like charge would understate the
//   round trip cost whenever quantity differs between entry and exit.

export function basisPointCosts(config: BacktestConfig): CostModel {
  return {
    buyFillPrice: (referenceOpenUnits) => addBpsUp(referenceOpenUnits, config.slippageBps),
    sellFillPrice: (referenceOpenUnits) => subtractBpsDown(referenceOpenUnits, config.slippageBps),
    fee: (notionalUnits) => bpsOfUp(notionalUnits, config.takerFeeBps),
  };
}

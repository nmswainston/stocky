import { buyAndHold } from './strategies/buy-and-hold.js';
import { smaCrossover } from './strategies/sma-crossover.js';
import type { Strategy } from './types.js';

// One place that turns a serializable spec into a strategy instance.
// The paper trader stores the spec in its state file so a resumed
// session reconstructs exactly the strategy it started with.

export type StrategySpec =
  | { kind: 'buyhold' }
  | { kind: 'sma'; fast: number; slow: number };

export function buildStrategy(spec: StrategySpec): Strategy<unknown> {
  switch (spec.kind) {
    case 'buyhold':
      return buyAndHold as Strategy<unknown>;
    case 'sma':
      return smaCrossover(spec.fast, spec.slow) as Strategy<unknown>;
  }
}

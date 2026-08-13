import { buyAndHold } from './strategies/buy-and-hold.js';
import { meanReversion } from './strategies/mean-reversion.js';
import { smaCrossover } from './strategies/sma-crossover.js';
import { volatilityFilter } from './strategies/volatility-filter.js';
import type { Strategy } from './types.js';

// One place that turns a serializable spec into a strategy instance.
// The paper trader stores the spec in its state file so a resumed
// session reconstructs exactly the strategy it started with. Specs
// nest: a volatility filter wraps any inner spec, including another
// filter, though one level is the sane amount.

export type StrategySpec =
  | { kind: 'buyhold' }
  | { kind: 'sma'; fast: number; slow: number }
  | { kind: 'meanrev'; period: number; entryZ: number; exitZ: number }
  | {
      kind: 'volfiltered';
      mode: 'above' | 'below';
      period: number;
      thresholdBps: number;
      inner: StrategySpec;
    };

export function buildStrategy(spec: StrategySpec): Strategy<unknown> {
  switch (spec.kind) {
    case 'buyhold':
      return buyAndHold as Strategy<unknown>;
    case 'sma':
      return smaCrossover(spec.fast, spec.slow) as Strategy<unknown>;
    case 'meanrev':
      return meanReversion(spec.period, spec.entryZ, spec.exitZ) as Strategy<unknown>;
    case 'volfiltered':
      return volatilityFilter(
        buildStrategy(spec.inner),
        spec.mode,
        spec.period,
        spec.thresholdBps,
      ) as Strategy<unknown>;
  }
}

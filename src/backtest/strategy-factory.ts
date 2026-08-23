import { numberArg } from '../cli-args.js';
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

// Shared CLI flag parsing: --strategy plus its parameters, and the
// optional --vol-filter wrapper. Used by the walkforward CLI; the
// backtest and paper CLIs predate it and carry their own copies.
export function specFromArgs(args: Map<string, string>): StrategySpec {
  const name = args.get('strategy') ?? 'buyhold';
  let spec: StrategySpec;
  switch (name) {
    case 'buyhold':
      spec = { kind: 'buyhold' };
      break;
    case 'sma':
      spec = { kind: 'sma', fast: numberArg(args, 'fast', 20), slow: numberArg(args, 'slow', 50) };
      break;
    case 'meanrev':
      spec = {
        kind: 'meanrev',
        period: numberArg(args, 'period', 20),
        entryZ: numberArg(args, 'entry-z', 2),
        exitZ: numberArg(args, 'exit-z', 0.5),
      };
      break;
    default:
      throw new Error(`unknown strategy ${name}, expected buyhold, sma, or meanrev`);
  }
  const volMode = args.get('vol-filter');
  if (volMode === 'above' || volMode === 'below') {
    spec = {
      kind: 'volfiltered',
      mode: volMode,
      period: numberArg(args, 'vol-period', 20),
      thresholdBps: numberArg(args, 'vol-bps', 10),
      inner: spec,
    };
  }
  return spec;
}

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

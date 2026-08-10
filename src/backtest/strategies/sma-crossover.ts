import { toUnits } from '../../decimal.js';
import type { Strategy } from '../types.js';

// Long while the fast SMA is above the slow SMA, flat otherwise.
//
// The comparison is done in exact integer math: fastSum / fastPeriod >
// slowSum / slowPeriod is rewritten as fastSum * slowPeriod > slowSum *
// fastPeriod, so there is no float division anywhere near the signal. A
// crossover that hinges on the 15th decimal of a float average is
// exactly the kind of thing that backtests differently than it runs.

export interface SmaState {
  fastAboveSlow: boolean;
}

export function smaCrossover(fastPeriod: number, slowPeriod: number): Strategy<SmaState> {
  if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod)) {
    throw new Error('SMA periods must be integers');
  }
  if (fastPeriod < 1 || slowPeriod <= fastPeriod) {
    throw new Error('require 1 <= fast < slow');
  }
  const sumOfCloses = (bars: readonly { close: string }[]): bigint =>
    bars.reduce((sum, bar) => sum + toUnits(bar.close), 0n);

  return {
    name: `sma-crossover(${fastPeriod}/${slowPeriod})`,
    warmupBars: slowPeriod,
    decide: (window) => {
      const fastSum = sumOfCloses(window.lastN(Math.min(fastPeriod, window.length)));
      const slowSum = sumOfCloses(window.lastN(Math.min(slowPeriod, window.length)));
      const fastAboveSlow =
        fastSum * BigInt(slowPeriod) > slowSum * BigInt(fastPeriod);
      return {
        signal: fastAboveSlow ? 'long' : 'flat',
        state: { fastAboveSlow },
      };
    },
  };
}

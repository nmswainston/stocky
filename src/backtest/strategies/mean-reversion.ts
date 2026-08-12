import { toUnits } from '../../decimal.js';
import type { Strategy } from '../types.js';

// Long-only z-score mean reversion: enter when the close stretches more
// than entryZ standard deviations below the rolling mean, exit once it
// reverts to within exitZ. The opposite philosophy to the SMA follower,
// which is exactly why it earns a place in the paper battery.
//
// The signal never touches a float. z < -k looks like it needs a square
// root, but squaring both sides turns it into an exact bigint check:
//   mean = S / n, deviation = c - mean = (n*c - S) / n
//   stdev = sqrt(ssq / n^3) where ssq = sum((n*c_i - S)^2)  [population]
//   z < -k  <=>  (n*c - S) < 0  AND  (n*c - S)^2 * n * q^2 > p^2 * ssq
// with the threshold k expressed as the rational p/q in hundredths.
// Comparisons are strict: a close sitting exactly at the threshold does
// not trade, and the boundary test pins that.

export interface MeanReversionState {
  holding: boolean;
}

export function meanReversion(
  period: number,
  entryZ: number,
  exitZ: number,
): Strategy<MeanReversionState> {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error('mean reversion period must be an integer >= 2');
  }
  if (!(entryZ > 0) || !(exitZ >= 0) || !(entryZ > exitZ)) {
    throw new Error('require entryZ > exitZ >= 0 and entryZ > 0');
  }
  const Q = 100n;
  const entryP = BigInt(Math.round(entryZ * 100));
  const exitP = BigInt(Math.round(exitZ * 100));

  return {
    name: `mean-reversion(${period}/${entryZ}/${exitZ})`,
    warmupBars: period,
    decide: (window, prior) => {
      const holding = prior?.holding ?? false;
      const bars = window.lastN(Math.min(period, window.length));
      const n = BigInt(bars.length);
      const closes = bars.map((bar) => toUnits(bar.close));
      const sum = closes.reduce((a, b) => a + b, 0n);
      const scaledDeviation = n * (closes[closes.length - 1] as bigint) - sum;
      let ssq = 0n;
      for (const close of closes) {
        const d = n * close - sum;
        ssq += d * d;
      }

      // A flat window has no stretch to revert from: never enter, and
      // release any holding, since z is effectively zero.
      if (ssq === 0n) {
        return { signal: 'flat', state: { holding: false } };
      }

      const stretchedBelow = (p: bigint): boolean =>
        scaledDeviation < 0n &&
        scaledDeviation * scaledDeviation * n * Q * Q > p * p * ssq;

      // Hysteresis: enter past the deep threshold, stay until the price
      // reverts inside the shallow one.
      const nextHolding = holding ? stretchedBelow(exitP) : stretchedBelow(entryP);
      return {
        signal: nextHolding ? 'long' : 'flat',
        state: { holding: nextHolding },
      };
    },
  };
}

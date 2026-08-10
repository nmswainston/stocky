import type { BarWindow, ClosedBar } from './types.js';

// The window closes over the engine's bar array and a fixed exclusive
// limit. It never copies bars and it never grows: the engine creates a
// fresh window per decision, so a strategy that stashes an old window
// keeps its old limit and still cannot reach later bars.

export function createBarWindow(bars: readonly ClosedBar[], limitExclusive: number): BarWindow {
  if (limitExclusive < 1 || limitExclusive > bars.length) {
    throw new RangeError(`window limit ${limitExclusive} outside [1, ${bars.length}]`);
  }
  const length = limitExclusive;
  return {
    length,
    at(index: number): ClosedBar {
      if (!Number.isInteger(index) || index < 0 || index >= length) {
        throw new RangeError(`bar index ${index} outside [0, ${length})`);
      }
      // length <= bars.length is checked above, so this cannot be undefined
      return bars[index] as ClosedBar;
    },
    get last(): ClosedBar {
      return bars[length - 1] as ClosedBar;
    },
    lastN(count: number): readonly ClosedBar[] {
      if (!Number.isInteger(count) || count < 1 || count > length) {
        throw new RangeError(`lastN(${count}) outside [1, ${length}]`);
      }
      return bars.slice(length - count, length);
    },
  };
}

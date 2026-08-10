import type { ClosedBar } from '../types.js';

// Fabricated bars for engine tests. Frozen like the real loader's bars.

export function bar(
  minuteIndex: number,
  open: string,
  close: string,
  overrides: Partial<ClosedBar> = {},
): ClosedBar {
  const time = new Date(Date.UTC(2026, 0, 1, 0, minuteIndex)).toISOString();
  const high = Number(open) > Number(close) ? open : close;
  const low = Number(open) < Number(close) ? open : close;
  return Object.freeze({
    symbol: 'TEST-USD',
    bucketStart: time,
    open,
    high,
    low,
    close,
    volume: '1.00000000',
    tradeCount: 1,
    ...overrides,
  });
}

export function barsFromCloses(closes: readonly string[]): ClosedBar[] {
  // Each bar opens at the prior close so price paths are continuous.
  return closes.map((close, index) =>
    bar(index, index === 0 ? close : (closes[index - 1] as string), close),
  );
}

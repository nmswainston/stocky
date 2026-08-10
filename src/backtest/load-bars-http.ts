import type { ClosedBar } from './types.js';

// Bar loader that asks the running collector instead of opening the
// database file. Same output contract as load-bars.ts, which is what
// lets backtests run while the collector holds the DuckDB lock.

export async function loadBarsHttp(
  baseUrl: string,
  symbol: string,
  from?: string,
  to?: string,
): Promise<ClosedBar[]> {
  const params = new URLSearchParams({ symbol, limit: '50000' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const response = await fetch(`${baseUrl}/api/bars?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`collector API answered ${response.status} for /api/bars`);
  }
  const payload = (await response.json()) as { bars: ClosedBar[] };
  return payload.bars.map((bar) =>
    Object.freeze({
      symbol: String(bar.symbol),
      bucketStart: String(bar.bucketStart),
      open: String(bar.open),
      high: String(bar.high),
      low: String(bar.low),
      close: String(bar.close),
      volume: String(bar.volume),
      tradeCount: Number(bar.tradeCount),
    }),
  );
}

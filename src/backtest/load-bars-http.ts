import type { ClosedBar } from './types.js';

// Bar loader that asks the running collector instead of opening the
// database file. Same output contract as load-bars.ts, which is what
// lets backtests run while the collector holds the DuckDB lock.
//
// Reads are paginated with an ascending cursor ('head' direction), so
// there is no history ceiling: the API's 50k per-request cap becomes a
// page size, not a silent truncation.

export async function loadBarsHttp(
  baseUrl: string,
  symbol: string,
  from?: string,
  to?: string,
  pageSize = 50_000,
): Promise<ClosedBar[]> {
  const all: ClosedBar[] = [];
  let cursor = from;
  for (;;) {
    const params = new URLSearchParams({
      symbol,
      limit: String(pageSize),
      direction: 'head',
    });
    if (cursor) params.set('from', cursor);
    if (to) params.set('to', to);
    const response = await fetch(`${baseUrl}/api/bars?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`collector API answered ${response.status} for /api/bars`);
    }
    const payload = (await response.json()) as { bars: ClosedBar[] };
    for (const bar of payload.bars) {
      all.push(
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
    if (payload.bars.length < pageSize) return all;
    // One millisecond past the last bar excludes it from the next page.
    const lastBar = all[all.length - 1] as ClosedBar;
    cursor = new Date(Date.parse(lastBar.bucketStart) + 1).toISOString();
  }
}

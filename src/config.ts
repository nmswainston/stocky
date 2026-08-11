// All tunable values live here so the rest of the code reads as intent.

export const config = {
  coinbase: {
    websocketUrl: 'wss://advanced-trade-ws.coinbase.com',
    productIds: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    // Heartbeats arrive roughly once per second. If nothing at all arrives
    // for this long, the connection is considered dead and is torn down.
    silenceTimeoutMs: 15_000,
  },
  reconnect: {
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    multiplier: 2,
  },
  storage: {
    databasePath: 'data/stocky.duckdb',
    parquetDirectory: 'data/parquet/trades',
    flushIntervalMs: 5_000,
  },
  bars: {
    bucketMs: 60_000,
    // A bucket is finalized once wall clock time is this far past its end,
    // so slightly late trades still land in the right bar.
    finalizeGraceMs: 5_000,
  },
  status: {
    // Loopback by default. On a headless box set STOCKY_HOST=0.0.0.0
    // to reach the dashboard from other machines on the LAN; the API
    // is read-only, so exposure is just market data.
    host: process.env.STOCKY_HOST ?? '127.0.0.1',
    port: Number(process.env.STOCKY_PORT ?? 8787),
  },
} as const;

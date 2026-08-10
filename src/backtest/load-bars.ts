import { DuckDBInstance } from '@duckdb/node-api';
import type { ClosedBar } from './types.js';

// The only side effect in the backtester: reading bars. Opens the
// database read-only so a backtest can never touch collector data, and
// freezes every bar so nothing downstream can mutate history.

export async function loadBars(
  databasePath: string,
  symbol: string,
  from?: string,
  to?: string,
): Promise<ClosedBar[]> {
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(databasePath, { access_mode: 'READ_ONLY' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('lock')) {
      throw new Error(
        `database is locked, stop the collector before backtesting (${databasePath})`,
      );
    }
    throw error;
  }
  const connection = await instance.connect();
  try {
    const result = await connection.runAndReadAll(
      `
      SELECT
        symbol,
        strftime(bucket_start, '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS bucket_start,
        CAST(open AS VARCHAR) AS open,
        CAST(high AS VARCHAR) AS high,
        CAST(low AS VARCHAR) AS low,
        CAST(close AS VARCHAR) AS close,
        CAST(volume AS VARCHAR) AS volume,
        trade_count
      FROM bars_1m
      WHERE symbol = ?
        AND bucket_start >= COALESCE(CAST(? AS TIMESTAMP), TIMESTAMP '1970-01-01')
        AND bucket_start <= COALESCE(CAST(? AS TIMESTAMP), TIMESTAMP '9999-12-31')
      ORDER BY bucket_start
      `,
      [symbol, from ?? null, to ?? null],
    );
    return result.getRowObjects().map((row) =>
      Object.freeze({
        symbol: String(row.symbol),
        bucketStart: String(row.bucket_start),
        open: String(row.open),
        high: String(row.high),
        low: String(row.low),
        close: String(row.close),
        volume: String(row.volume),
        tradeCount: Number(row.trade_count),
      }),
    );
  } finally {
    connection.closeSync();
  }
}

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { Bar } from './bar-aggregator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import type { Trade } from './parse.js';

// All DuckDB access lives here. The rest of the app hands over plain
// objects and never sees SQL.
//
// Write path (option B): trades land in the `trades` table on each flush.
// Completed UTC days are exported to hive-partitioned Parquet and the
// exported rows are deleted, so the table only ever holds the current day.

const log = logger.child({ module: 'storage' });

const INSERT_CHUNK_SIZE = 500;

export class Storage {
  private constructor(private readonly connection: DuckDBConnection) {}

  static async open(databasePath: string = config.storage.databasePath): Promise<Storage> {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    mkdirSync(config.storage.parquetDirectory, { recursive: true });
    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    const storage = new Storage(connection);
    await storage.createTables();
    return storage;
  }

  private async createTables(): Promise<void> {
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS trades (
        trade_id VARCHAR NOT NULL,
        symbol VARCHAR NOT NULL,
        price DECIMAL(18, 8) NOT NULL,
        size DECIMAL(18, 8) NOT NULL,
        side VARCHAR NOT NULL,
        exchange_time TIMESTAMP NOT NULL,
        received_at TIMESTAMP NOT NULL,
        sequence_num BIGINT NOT NULL
      )
    `);
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS bars_1m (
        symbol VARCHAR NOT NULL,
        bucket_start TIMESTAMP NOT NULL,
        open DECIMAL(18, 8) NOT NULL,
        high DECIMAL(18, 8) NOT NULL,
        low DECIMAL(18, 8) NOT NULL,
        close DECIMAL(18, 8) NOT NULL,
        volume DECIMAL(18, 8) NOT NULL,
        trade_count INTEGER NOT NULL,
        complete BOOLEAN NOT NULL DEFAULT true,
        PRIMARY KEY (symbol, bucket_start)
      )
    `);
    // Migration for databases created before completeness existed. The
    // added column is nullable there; reads treat null as complete,
    // since those bars predate taint detection.
    await this.connection.run(
      'ALTER TABLE bars_1m ADD COLUMN IF NOT EXISTS complete BOOLEAN DEFAULT true',
    );
  }

  async insertTrades(trades: Trade[]): Promise<void> {
    for (let offset = 0; offset < trades.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = trades.slice(offset, offset + INSERT_CHUNK_SIZE);
      const rowPlaceholder =
        '(?, ?, CAST(? AS DECIMAL(18, 8)), CAST(? AS DECIMAL(18, 8)), ?, CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ?)';
      const sql = `
        INSERT INTO trades
          (trade_id, symbol, price, size, side, exchange_time, received_at, sequence_num)
        VALUES ${chunk.map(() => rowPlaceholder).join(', ')}
      `;
      const values = chunk.flatMap((trade) => [
        trade.tradeId,
        trade.symbol,
        trade.price,
        trade.size,
        trade.side,
        trade.exchangeTime,
        trade.receivedAt,
        BigInt(trade.sequenceNum),
      ]);
      await this.connection.run(sql, values);
    }
  }

  // Upsert rather than plain insert: the same bucket can be written twice,
  // once as a partial bar at shutdown and again after a restart rebuilds it
  // from raw trades. Last write wins and is the more complete one.
  async upsertBars(bars: Bar[]): Promise<void> {
    for (const bar of bars) {
      await this.connection.run(
        `
        INSERT INTO bars_1m (symbol, bucket_start, open, high, low, close, volume, trade_count, complete)
        VALUES (?, CAST(? AS TIMESTAMP),
          CAST(? AS DECIMAL(18, 8)), CAST(? AS DECIMAL(18, 8)),
          CAST(? AS DECIMAL(18, 8)), CAST(? AS DECIMAL(18, 8)),
          CAST(? AS DECIMAL(18, 8)), ?, ?)
        ON CONFLICT (symbol, bucket_start) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume,
          trade_count = excluded.trade_count,
          complete = excluded.complete
        `,
        [bar.symbol, bar.bucketStart, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.tradeCount, bar.complete ?? true],
      );
    }
  }

  // Recovery writes: bars rebuilt from stored trades for buckets that
  // were never finalized (the process died mid-bucket). They are only
  // ever inserted where no bar exists, so a properly finalized bar is
  // never downgraded by a reconstruction.
  async insertBarsIfAbsent(bars: Bar[]): Promise<number> {
    let inserted = 0;
    for (const bar of bars) {
      const existing = await this.connection.runAndReadAll(
        'SELECT 1 FROM bars_1m WHERE symbol = ? AND bucket_start = CAST(? AS TIMESTAMP)',
        [bar.symbol, bar.bucketStart],
      );
      if (existing.getRowObjects().length > 0) continue;
      await this.connection.run(
        `
        INSERT INTO bars_1m (symbol, bucket_start, open, high, low, close, volume, trade_count, complete)
        VALUES (?, CAST(? AS TIMESTAMP),
          CAST(? AS DECIMAL(18, 8)), CAST(? AS DECIMAL(18, 8)),
          CAST(? AS DECIMAL(18, 8)), CAST(? AS DECIMAL(18, 8)),
          CAST(? AS DECIMAL(18, 8)), ?, ?)
        ON CONFLICT (symbol, bucket_start) DO NOTHING
        `,
        [bar.symbol, bar.bucketStart, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.tradeCount, bar.complete ?? false],
      );
      inserted += 1;
    }
    return inserted;
  }

  // Trades at or after the given instant, oldest first. Used on startup to
  // rebuild the in-progress bar and to re-seed the duplicate filter.
  async tradesSince(sinceIso: string): Promise<Trade[]> {
    const result = await this.connection.runAndReadAll(
      `
      SELECT
        trade_id,
        symbol,
        CAST(price AS VARCHAR) AS price,
        CAST(size AS VARCHAR) AS size,
        side,
        strftime(exchange_time, '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS exchange_time,
        strftime(received_at, '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS received_at,
        sequence_num
      FROM trades
      WHERE exchange_time >= CAST(? AS TIMESTAMP)
      ORDER BY exchange_time
      `,
      [sinceIso],
    );
    return result.getRowObjects().map((row) => ({
      tradeId: String(row.trade_id),
      symbol: String(row.symbol),
      price: String(row.price),
      size: String(row.size),
      side: row.side === 'SELL' ? 'SELL' : 'BUY',
      exchangeTime: String(row.exchange_time),
      receivedAt: String(row.received_at),
      sequenceNum: Number(row.sequence_num),
    }));
  }

  // Read-only window of finalized bars for the API. The in-progress
  // minute lives only in the aggregator's memory, so the dashboard shows
  // exactly what a strategy would be allowed to see: closed bars.
  // direction 'tail' returns the newest N in ascending order (dashboard
  // charts). direction 'head' returns the oldest N ascending, which is
  // what makes cursor pagination possible for unbounded reads.
  async readBars(
    symbol: string,
    from?: string,
    to?: string,
    limit = 2_000,
    direction: 'tail' | 'head' = 'tail',
  ): Promise<
    Array<{
      symbol: string;
      bucketStart: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      tradeCount: number;
      complete: boolean;
    }>
  > {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), 50_000);
    const columns = `
      symbol,
      strftime(bucket_start, '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS bucket_start,
      CAST(open AS VARCHAR) AS open,
      CAST(high AS VARCHAR) AS high,
      CAST(low AS VARCHAR) AS low,
      CAST(close AS VARCHAR) AS close,
      CAST(volume AS VARCHAR) AS volume,
      trade_count,
      COALESCE(complete, true) AS complete
    `;
    const bounds = `
      symbol = ?
      AND bucket_start >= COALESCE(CAST(? AS TIMESTAMP), TIMESTAMP '1970-01-01')
      AND bucket_start <= COALESCE(CAST(? AS TIMESTAMP), TIMESTAMP '9999-12-31')
    `;
    // Tail: newest rows win when the limit bites, then flip ascending.
    const sql =
      direction === 'head'
        ? `SELECT ${columns} FROM bars_1m WHERE ${bounds} ORDER BY bucket_start ASC LIMIT ${bounded}`
        : `SELECT * FROM (
             SELECT ${columns} FROM bars_1m WHERE ${bounds}
             ORDER BY bucket_start DESC LIMIT ${bounded}
           ) ORDER BY bucket_start ASC`;
    const result = await this.connection.runAndReadAll(sql, [symbol, from ?? null, to ?? null]);
    return result.getRowObjects().map((row) => ({
      symbol: String(row.symbol),
      bucketStart: String(row.bucket_start),
      open: String(row.open),
      high: String(row.high),
      low: String(row.low),
      close: String(row.close),
      volume: String(row.volume),
      tradeCount: Number(row.trade_count),
      complete: row.complete !== false,
    }));
  }

  // Per-day, per-symbol bar counts for the health timeline. Expected
  // counts are computed by the caller from each symbol's first bar and
  // the current time, so partial first days and today read fairly.
  async readHealth(): Promise<{
    days: Array<{ day: string; symbol: string; bars: number; incomplete: number }>;
    firstBars: Record<string, string>;
  }> {
    const rows = await this.connection.runAndReadAll(`
      SELECT
        CAST(CAST(bucket_start AS DATE) AS VARCHAR) AS day,
        symbol,
        COUNT(*) AS bars,
        SUM(CASE WHEN COALESCE(complete, true) THEN 0 ELSE 1 END) AS incomplete
      FROM bars_1m
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    const firsts = await this.connection.runAndReadAll(`
      SELECT symbol, strftime(MIN(bucket_start), '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS first_bar
      FROM bars_1m GROUP BY symbol
    `);
    const firstBars: Record<string, string> = {};
    for (const row of firsts.getRowObjects()) {
      firstBars[String(row.symbol)] = String(row.first_bar);
    }
    return {
      days: rows.getRowObjects().map((row) => ({
        day: String(row.day),
        symbol: String(row.symbol),
        bars: Number(row.bars),
        incomplete: Number(row.incomplete),
      })),
      firstBars,
    };
  }

  // Latest trade per symbol, for the dashboard's price readout. The
  // trades table holds the current UTC day, which is exactly the
  // liveness window this exists to show.
  async readTicker(): Promise<Array<{ symbol: string; price: string; side: string; time: string }>> {
    const result = await this.connection.runAndReadAll(`
      SELECT
        symbol,
        CAST(arg_max(price, exchange_time) AS VARCHAR) AS price,
        arg_max(side, exchange_time) AS side,
        strftime(max(exchange_time), '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS time
      FROM trades
      GROUP BY symbol
      ORDER BY symbol
    `);
    return result.getRowObjects().map((row) => ({
      symbol: String(row.symbol),
      price: String(row.price),
      side: String(row.side),
      time: String(row.time),
    }));
  }

  // Newest trades first, for the dashboard tape.
  async readRecentTrades(
    symbol: string,
    limit = 30,
  ): Promise<Array<{ tradeId: string; price: string; size: string; side: string; time: string }>> {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), 200);
    const result = await this.connection.runAndReadAll(
      `
      SELECT
        trade_id,
        CAST(price AS VARCHAR) AS price,
        CAST(size AS VARCHAR) AS size,
        side,
        strftime(exchange_time, '%Y-%m-%dT%H:%M:%S.%f') || 'Z' AS time
      FROM trades
      WHERE symbol = ?
      ORDER BY exchange_time DESC
      LIMIT ${bounded}
      `,
      [symbol],
    );
    return result.getRowObjects().map((row) => ({
      tradeId: String(row.trade_id),
      price: String(row.price),
      size: String(row.size),
      side: String(row.side),
      time: String(row.time),
    }));
  }

  // Exports every UTC day older than the given date to partitioned Parquet,
  // then removes those rows from the table. Files land under
  // data/parquet/trades/date=YYYY-MM-DD/symbol=BTC-USD/.
  async exportDaysBefore(utcDate: string): Promise<number> {
    const countResult = await this.connection.runAndReadAll(
      'SELECT COUNT(*) AS n FROM trades WHERE CAST(exchange_time AS DATE) < CAST(? AS DATE)',
      [utcDate],
    );
    const rowCount = Number(countResult.getRowObjects()[0]?.n ?? 0);
    if (rowCount === 0) return 0;

    // Forward slashes keep the path literal portable inside SQL on Windows.
    const target = config.storage.parquetDirectory.replaceAll('\\', '/');
    await this.connection.run(
      `
      COPY (
        SELECT *, CAST(exchange_time AS DATE) AS date
        FROM trades
        WHERE CAST(exchange_time AS DATE) < CAST(? AS DATE)
        ORDER BY exchange_time
      ) TO '${target}' (FORMAT PARQUET, PARTITION_BY (date, symbol), APPEND)
      `,
      [utcDate],
    );
    // If the process dies between COPY and DELETE, the next export would
    // write these rows again into new files. Accepted for phase 1: the
    // failure window is tiny and duplicates are detectable by trade_id.
    await this.connection.run(
      'DELETE FROM trades WHERE CAST(exchange_time AS DATE) < CAST(? AS DATE)',
      [utcDate],
    );
    log.info({ rowCount, before: utcDate }, 'exported completed days to parquet');
    return rowCount;
  }

  async close(): Promise<void> {
    this.connection.closeSync();
  }
}

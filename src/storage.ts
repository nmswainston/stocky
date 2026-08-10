import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
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

  static async open(): Promise<Storage> {
    mkdirSync(path.dirname(config.storage.databasePath), { recursive: true });
    mkdirSync(config.storage.parquetDirectory, { recursive: true });
    const instance = await DuckDBInstance.create(config.storage.databasePath);
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

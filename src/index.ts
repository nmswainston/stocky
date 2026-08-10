import {
  applyTrade,
  bucketStartMsOf,
  emptyState,
  finalizeAll,
  finalizeStale,
  type AggregatorState,
  type Bar,
} from './bar-aggregator.js';
import { CoinbaseWebSocket } from './coinbase-ws.js';
import { config } from './config.js';
import { RecentIds } from './dedupe.js';
import { checkSequence } from './gap-detector.js';
import { logger } from './logger.js';
import { parseMessage } from './parse.js';
import { startStatusServer } from './status-server.js';
import { Storage } from './storage.js';
import { TradeBuffer } from './trade-buffer.js';

const storage = await Storage.open();
const buffer = new TradeBuffer((trades) => storage.insertTrades(trades));
const recentIds = new RecentIds(20_000);
const feed = new CoinbaseWebSocket();

let barState: AggregatorState = emptyState();
let previousSequence: number | null = null;
let gapCount = 0;
let duplicatesSkipped = 0;
let lateTrades = 0;
let barsWritten = 0;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeBars(bars: Bar[]): void {
  if (bars.length === 0) return;
  storage
    .upsertBars(bars)
    .then(() => {
      barsWritten += bars.length;
      for (const bar of bars) logger.info({ bar }, 'bar finalized');
    })
    .catch((error) => {
      logger.error({ err: error, count: bars.length }, 'bar write failed');
    });
}

// Restart recovery: re-seed the duplicate filter from the last few minutes
// of stored trades, and rebuild the current in-progress bar by replaying
// this minute's trades through the same pure aggregator.
{
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const recentTrades = await storage.tradesSince(tenMinutesAgo);
  const currentBucketMs = Math.floor(Date.now() / config.bars.bucketMs) * config.bars.bucketMs;
  for (const trade of recentTrades) {
    recentIds.seen(`${trade.symbol}:${trade.tradeId}`);
    if (bucketStartMsOf(trade.exchangeTime, config.bars.bucketMs) === currentBucketMs) {
      barState = applyTrade(barState, trade, config.bars.bucketMs).state;
    }
  }
  if (recentTrades.length > 0) {
    logger.info({ count: recentTrades.length }, 'seeded state from stored trades');
  }
}

// Export any leftover completed days from previous runs, then re-check
// hourly so the day rollover is picked up without a restart.
await storage.exportDaysBefore(todayUtc());
const exportTimer = setInterval(() => {
  storage.exportDaysBefore(todayUtc()).catch((error) => {
    logger.error({ err: error }, 'parquet export failed');
  });
}, 60 * 60 * 1000);

// Closes bars for symbols that stopped trading, since no later trade will
// arrive to push them out.
const finalizeTimer = setInterval(() => {
  const result = finalizeStale(barState, Date.now(), config.bars.bucketMs, config.bars.finalizeGraceMs);
  barState = result.state;
  writeBars(result.finalized);
}, config.bars.finalizeGraceMs);

feed.on('open', () => {
  // A new connection starts a new sequence stream.
  previousSequence = null;
});

feed.on('message', (payload) => {
  const receivedAt = new Date().toISOString();
  const message = parseMessage(payload, receivedAt);

  if (message.kind === 'error') {
    logger.error({ message: message.message }, 'feed error message');
    return;
  }
  if (message.kind === 'unknown') {
    logger.warn({ channel: message.channel }, 'unknown channel');
    return;
  }

  const check = checkSequence(previousSequence, message.sequenceNum);
  previousSequence = message.sequenceNum;
  if (check.status === 'gap') {
    gapCount += 1;
    logger.warn(
      { missed: check.missed, sequenceNum: message.sequenceNum, gapCount },
      'sequence gap detected',
    );
  } else if (check.status === 'regression') {
    logger.warn(
      { delta: check.delta, sequenceNum: message.sequenceNum },
      'sequence went backwards',
    );
  }

  if (message.kind !== 'trades') return;
  if (message.skipped > 0) {
    logger.warn({ skipped: message.skipped }, 'malformed trades skipped');
  }

  const freshTrades = message.trades.filter((trade) => {
    const isDuplicate = recentIds.seen(`${trade.symbol}:${trade.tradeId}`);
    if (isDuplicate) duplicatesSkipped += 1;
    return !isDuplicate;
  });
  if (freshTrades.length === 0) return;

  buffer.add(freshTrades);

  // Snapshot events list recent trades newest first (verified against the
  // live feed). Sort them oldest first so open and close come out right,
  // and drop trades from minutes that already ended: the snapshot window
  // is only ~100 trades, so those minutes cannot be aggregated completely.
  // The raw trades are still stored above. The first bar after a cold
  // start is best effort for the same reason: we may join mid-minute.
  let tradesForBars = freshTrades;
  if (message.eventType === 'snapshot') {
    const currentBucketMs = Math.floor(Date.now() / config.bars.bucketMs) * config.bars.bucketMs;
    tradesForBars = freshTrades
      .filter((trade) => bucketStartMsOf(trade.exchangeTime, config.bars.bucketMs) >= currentBucketMs)
      .sort((a, b) => Date.parse(a.exchangeTime) - Date.parse(b.exchangeTime));
    logger.info(
      { snapshotTrades: freshTrades.length, usedForBars: tradesForBars.length },
      'snapshot processed',
    );
  }

  const finalized: Bar[] = [];
  for (const trade of tradesForBars) {
    const result = applyTrade(barState, trade, config.bars.bucketMs);
    barState = result.state;
    finalized.push(...result.finalized);
    if (result.late) lateTrades += 1;
  }
  writeBars(finalized);
});

feed.on('down', (reason) => {
  logger.warn({ reason }, 'feed down');
});

const startedAtMs = Date.now();
const statusServer = startStatusServer(() => {
  const connection = feed.stats();
  return {
    uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    connected: connection.connected,
    messagesReceived: connection.messagesReceived,
    lastMessageAt: connection.lastMessageAt,
    reconnectCount: connection.reconnectCount,
    gapCount,
    duplicatesSkipped,
    lateTrades,
    buffered: buffer.stats().buffered,
    tradesWritten: buffer.stats().totalFlushed,
    barsWritten,
  };
});

buffer.start();
feed.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, duplicatesSkipped, gapCount, lateTrades, barsWritten }, 'shutting down');
  feed.stop();
  statusServer.close();
  clearInterval(exportTimer);
  clearInterval(finalizeTimer);
  try {
    await buffer.stop();
    const result = finalizeAll(barState);
    barState = result.state;
    await storage.upsertBars(result.finalized);
    await storage.exportDaysBefore(todayUtc());
    await storage.close();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown flush failed');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

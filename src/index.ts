import { CoinbaseWebSocket } from './coinbase-ws.js';
import { RecentIds } from './dedupe.js';
import { checkSequence } from './gap-detector.js';
import { logger } from './logger.js';
import { parseMessage } from './parse.js';
import { Storage } from './storage.js';
import { TradeBuffer } from './trade-buffer.js';

const storage = await Storage.open();
const buffer = new TradeBuffer((trades) => storage.insertTrades(trades));
const recentIds = new RecentIds(20_000);
const feed = new CoinbaseWebSocket();

let previousSequence: number | null = null;
let gapCount = 0;
let duplicatesSkipped = 0;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Export any leftover completed days from previous runs, then re-check
// hourly so the day rollover is picked up without a restart.
await storage.exportDaysBefore(todayUtc());
const exportTimer = setInterval(() => {
  storage.exportDaysBefore(todayUtc()).catch((error) => {
    logger.error({ err: error }, 'parquet export failed');
  });
}, 60 * 60 * 1000);

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
});

feed.on('down', (reason) => {
  logger.warn({ reason }, 'feed down');
});

buffer.start();
feed.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, duplicatesSkipped, gapCount }, 'shutting down');
  feed.stop();
  clearInterval(exportTimer);
  try {
    await buffer.stop();
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

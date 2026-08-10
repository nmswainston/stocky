import { CoinbaseWebSocket } from './coinbase-ws.js';
import { checkSequence } from './gap-detector.js';
import { logger } from './logger.js';
import { parseMessage } from './parse.js';

const feed = new CoinbaseWebSocket();

let previousSequence: number | null = null;
let gapCount = 0;

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

  if (message.kind === 'trades') {
    logger.debug(
      { count: message.trades.length, eventType: message.eventType, skipped: message.skipped },
      'trades',
    );
    if (message.skipped > 0) {
      logger.warn({ skipped: message.skipped }, 'malformed trades skipped');
    }
  }
});

feed.on('down', (reason) => {
  logger.warn({ reason }, 'feed down');
});

feed.start();

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  feed.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import { CoinbaseWebSocket } from './coinbase-ws.js';
import { logger } from './logger.js';

const feed = new CoinbaseWebSocket();

feed.on('message', (payload) => {
  logger.debug({ payload }, 'message');
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

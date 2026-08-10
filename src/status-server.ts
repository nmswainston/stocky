import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';

// One GET route returning a JSON snapshot. node:http is enough; Express
// would add a dependency for no benefit at this size.

const log = logger.child({ module: 'status-server' });

export interface StatusSnapshot {
  uptimeSeconds: number;
  connected: boolean;
  messagesReceived: number;
  lastMessageAt: string | null;
  reconnectCount: number;
  gapCount: number;
  duplicatesSkipped: number;
  lateTrades: number;
  buffered: number;
  tradesWritten: number;
  barsWritten: number;
}

export function startStatusServer(snapshot: () => StatusSnapshot): http.Server {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/status' || request.url === '/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(snapshot(), null, 2));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(config.status.port, config.status.host, () => {
    log.info({ host: config.status.host, port: config.status.port }, 'status server listening');
  });
  return server;
}

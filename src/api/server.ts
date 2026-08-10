import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Server bootstrap only. What the server answers lives in routes.ts.

const log = logger.child({ module: 'api-server' });

export function startServer(handler: http.RequestListener): http.Server {
  const server = http.createServer(handler);
  // Without this handler a taken port (usually a second instance of the
  // collector) crashes the process with an unhandled exception.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.fatal(
        { port: config.status.port },
        'port already in use, is another instance running?',
      );
    } else {
      log.fatal({ err: error }, 'http server failed');
    }
    process.exit(1);
  });
  server.listen(config.status.port, config.status.host, () => {
    log.info({ host: config.status.host, port: config.status.port }, 'listening');
  });
  return server;
}

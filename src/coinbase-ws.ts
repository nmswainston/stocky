import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';

// Owns the socket lifecycle: connect, subscribe, watchdog, reconnect with
// exponential backoff and jitter, and clean shutdown. It emits raw parsed
// JSON and knows nothing about trades, storage, or bars.
//
// Events:
//   'message' (payload: unknown)  every JSON message from the feed
//   'open'                        socket connected and subscriptions sent
//   'down'  (reason: string)      socket lost, a reconnect will follow

const log = logger.child({ module: 'coinbase-ws' });

export interface ConnectionStats {
  messagesReceived: number;
  lastMessageAt: string | null;
  reconnectCount: number;
  connected: boolean;
}

export class CoinbaseWebSocket extends EventEmitter {
  private socket: WebSocket | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private stopping = false;

  private messagesReceived = 0;
  private lastMessageAt: string | null = null;
  private reconnectCount = 0;

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.close(1000, 'shutdown');
      this.socket = null;
    }
  }

  stats(): ConnectionStats {
    return {
      messagesReceived: this.messagesReceived,
      lastMessageAt: this.lastMessageAt,
      reconnectCount: this.reconnectCount,
      connected: this.socket !== null && this.socket.readyState === WebSocket.OPEN,
    };
  }

  private connect(): void {
    if (this.stopping) return;
    log.info({ url: config.coinbase.websocketUrl }, 'connecting');
    const socket = new WebSocket(config.coinbase.websocketUrl);
    this.socket = socket;

    socket.on('open', () => {
      log.info('connected, subscribing');
      // One subscribe message per channel. market_trades carries the data,
      // heartbeats keeps the sequence flowing when the market is quiet so
      // both the watchdog and gap detection stay meaningful.
      for (const channel of ['market_trades', 'heartbeats']) {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            channel,
            product_ids: config.coinbase.productIds,
          }),
        );
      }
      this.emit('open');
    });

    socket.on('message', (raw) => {
      this.resetSilenceTimer();
      this.messagesReceived += 1;
      this.lastMessageAt = new Date().toISOString();
      // The first message proves the connection is healthy, so the backoff
      // schedule starts over.
      this.consecutiveFailures = 0;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        log.warn({ raw: raw.toString().slice(0, 200) }, 'unparseable message');
        return;
      }
      this.emit('message', payload);
    });

    socket.on('error', (error) => {
      log.warn({ err: error }, 'socket error');
    });

    socket.on('close', (code, reason) => {
      this.socket = null;
      if (this.stopping) return;
      const why = `close code=${code} reason=${reason.toString() || 'none'}`;
      this.emit('down', why);
      this.scheduleReconnect(why);
    });

    this.resetSilenceTimer();
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      log.warn(
        { silenceTimeoutMs: config.coinbase.silenceTimeoutMs },
        'no messages within timeout, terminating socket',
      );
      // terminate() skips the close handshake; the close event then fires
      // and drives the normal reconnect path.
      this.socket?.terminate();
    }, config.coinbase.silenceTimeoutMs);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || this.reconnectTimer) return;
    const { initialDelayMs, maxDelayMs, multiplier } = config.reconnect;
    const exponential = Math.min(
      maxDelayMs,
      initialDelayMs * multiplier ** this.consecutiveFailures,
    );
    // Equal jitter: half fixed, half random. Keeps a floor on the delay while
    // spreading reconnects out so restarts do not synchronize.
    const delay = Math.round(exponential / 2 + Math.random() * (exponential / 2));
    this.consecutiveFailures += 1;
    this.reconnectCount += 1;
    log.warn({ reason, delayMs: delay, attempt: this.consecutiveFailures }, 'reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.silenceTimer = null;
    this.reconnectTimer = null;
  }
}

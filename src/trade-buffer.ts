import { config } from './config.js';
import { logger } from './logger.js';
import type { Trade } from './parse.js';

// Collects trades in memory and hands them to a sink on an interval, so
// the hot message path never waits on the database.

const log = logger.child({ module: 'trade-buffer' });

export class TradeBuffer {
  private pending: Trade[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushInFlight = false;
  private totalFlushed = 0;

  constructor(private readonly sink: (trades: Trade[]) => Promise<void>) {}

  add(trades: Trade[]): void {
    this.pending.push(...trades);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, config.storage.flushIntervalMs);
  }

  async flush(): Promise<void> {
    if (this.flushInFlight || this.pending.length === 0) return;
    this.flushInFlight = true;
    const batch = this.pending;
    this.pending = [];
    try {
      await this.sink(batch);
      this.totalFlushed += batch.length;
      log.debug({ count: batch.length }, 'flushed');
    } catch (error) {
      // Put the batch back so nothing is lost; the next tick retries.
      this.pending = batch.concat(this.pending);
      log.error({ err: error, count: batch.length }, 'flush failed, batch requeued');
    } finally {
      this.flushInFlight = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  stats(): { buffered: number; totalFlushed: number } {
    return { buffered: this.pending.length, totalFlushed: this.totalFlushed };
  }
}

import { config } from './config.js';
import { logger } from './logger.js';
import type { Trade } from './parse.js';

// Collects trades in memory and hands them to a sink on an interval, so
// the hot message path never waits on the database.

const log = logger.child({ module: 'trade-buffer' });

export class TradeBuffer {
  private pending: Trade[] = [];
  private timer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<void> | null = null;
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

  // Callers always get a promise that resolves when the data they care
  // about has reached the sink or been requeued. If a flush is already
  // running, join it instead of returning early: returning early let
  // shutdown proceed and close storage under an in-flight write.
  flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (this.pending.length === 0) return Promise.resolve();
    const batch = this.pending;
    this.pending = [];
    this.activeFlush = (async () => {
      try {
        await this.sink(batch);
        this.totalFlushed += batch.length;
        log.debug({ count: batch.length }, 'flushed');
      } catch (error) {
        // Put the batch back so nothing is lost; the next tick retries.
        this.pending = batch.concat(this.pending);
        log.error({ err: error, count: batch.length }, 'flush failed, batch requeued');
      } finally {
        this.activeFlush = null;
      }
    })();
    return this.activeFlush;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Two passes: the first joins any in-flight flush (or flushes the
    // pending batch), the second drains trades that arrived while the
    // first was writing. Only then is it safe to close storage.
    await this.flush();
    await this.flush();
  }

  stats(): { buffered: number; totalFlushed: number } {
    return { buffered: this.pending.length, totalFlushed: this.totalFlushed };
  }
}

import { describe, expect, it } from 'vitest';
import type { Trade } from './parse.js';
import { TradeBuffer } from './trade-buffer.js';

const trade = (id: string): Trade => ({
  tradeId: id,
  symbol: 'TEST-USD',
  price: '100.00',
  size: '1.00',
  side: 'BUY',
  exchangeTime: '2026-08-10T12:00:00.000000Z',
  receivedAt: '2026-08-10T12:00:00.100000Z',
  sequenceNum: 1,
});

// A sink whose completion the test controls, to hold a flush open while
// shutdown races against it.
function blockingSink() {
  const batches: Trade[][] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = true;
  const sink = async (trades: Trade[]): Promise<void> => {
    batches.push(trades);
    if (blocked) {
      blocked = false;
      await gate;
    }
  };
  return { sink, batches, release: () => release?.() };
}

describe('TradeBuffer shutdown concurrency', () => {
  it('stop() waits for an in-flight flush instead of racing past it', async () => {
    const { sink, batches, release } = blockingSink();
    const buffer = new TradeBuffer(sink);

    buffer.add([trade('1'), trade('2')]);
    const inFlight = buffer.flush();

    // Trades arrive while the first flush is stuck inside the sink.
    buffer.add([trade('3')]);

    let stopResolved = false;
    const stopping = buffer.stop().then(() => {
      stopResolved = true;
    });

    // Give stop() every chance to (wrongly) resolve early.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);

    release();
    await inFlight;
    await stopping;

    expect(stopResolved).toBe(true);
    // Both batches delivered, nothing lost, nothing duplicated.
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((t) => t.tradeId)).toEqual(['1', '2']);
    expect(batches[1]!.map((t) => t.tradeId)).toEqual(['3']);
    expect(buffer.stats().buffered).toBe(0);
    expect(buffer.stats().totalFlushed).toBe(3);
  });

  it('concurrent flush calls join the same write instead of starting a second', async () => {
    const { sink, batches, release } = blockingSink();
    const buffer = new TradeBuffer(sink);

    buffer.add([trade('1')]);
    const first = buffer.flush();
    const second = buffer.flush();

    release();
    await Promise.all([first, second]);
    expect(batches).toHaveLength(1);
  });

  it('a failed flush requeues and stop() retries it', async () => {
    let attempts = 0;
    const delivered: string[] = [];
    const buffer = new TradeBuffer(async (trades) => {
      attempts += 1;
      if (attempts === 1) throw new Error('storage hiccup');
      delivered.push(...trades.map((t) => t.tradeId));
    });

    buffer.add([trade('1')]);
    await buffer.flush();
    expect(buffer.stats().buffered).toBe(1);

    await buffer.stop();
    expect(delivered).toEqual(['1']);
    expect(buffer.stats().buffered).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { aggregateBars } from './aggregate.js';
import { bar } from './testing/fixtures.js';

describe('aggregateBars', () => {
  it('rejects nonsense timeframes and passes 1m through untouched', () => {
    expect(() => aggregateBars([], 0)).toThrow();
    expect(() => aggregateBars([], 2.5)).toThrow();
    const bars = [bar(0, '100', '101')];
    expect(aggregateBars(bars, 1)).toEqual(bars);
  });

  it('combines OHLCV correctly with exact volume sums', () => {
    const minute = (i: number, open: string, close: string, high: string, low: string, volume: string) =>
      bar(i, open, close, { high, low, volume });
    const bars = [
      minute(0, '100', '104', '105', '99', '0.10000000'),
      minute(1, '104', '101', '106', '100', '0.20000000'),
      minute(2, '101', '103', '103', '98', '0.30000000'),
      // Minute 3 opens the next bucket, proving the first one closed.
      minute(3, '103', '103', '103', '103', '1.00000000'),
    ];
    const [first] = aggregateBars(bars, 3);
    expect(first).toBeDefined();
    expect(first!.bucketStart).toBe(bars[0]!.bucketStart);
    expect(first!.open).toBe('100');
    expect(first!.close).toBe('103');
    expect(first!.high).toBe('106.00000000');
    expect(first!.low).toBe('98.00000000');
    // 0.1 + 0.2 + 0.3 exactly, where floats would give 0.6000000000000001.
    expect(first!.volume).toBe('0.60000000');
    expect(first!.tradeCount).toBe(3);
  });

  it('drops a trailing bucket that cannot be proven complete', () => {
    const bars = [bar(0, '100', '101'), bar(1, '101', '102'), bar(2, '102', '103'), bar(3, '103', '104')];
    // Minutes 0..2 form a complete 3m bucket; minute 3 starts the next
    // bucket but nothing proves that bucket ended.
    const aggregated = aggregateBars(bars, 3);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.close).toBe('103');
  });

  it('emits a trailing bucket that contains its own closing minute', () => {
    const bars = [bar(0, '100', '101'), bar(1, '101', '102'), bar(2, '102', '103')];
    const aggregated = aggregateBars(bars, 3);
    expect(aggregated).toHaveLength(1);
  });

  it('marks buckets incomplete when source bars are missing or lossy', () => {
    // Full bucket from complete sources: complete.
    const full = aggregateBars(
      [bar(0, '100', '101'), bar(1, '101', '102'), bar(2, '102', '103'), bar(3, '103', '104')],
      3,
    );
    expect(full[0]!.complete).toBe(true);
    expect(full[0]!.sourceBars).toBe(3);

    // Missing minute 1: structurally fine, marked incomplete.
    const gappy = aggregateBars(
      [bar(0, '100', '101'), bar(2, '102', '103'), bar(3, '103', '104')],
      3,
    );
    expect(gappy[0]!.complete).toBe(false);
    expect(gappy[0]!.sourceBars).toBe(2);

    // One lossy source poisons the whole bucket.
    const tainted = aggregateBars(
      [
        bar(0, '100', '101'),
        bar(1, '101', '102', { complete: false }),
        bar(2, '102', '103'),
        bar(3, '103', '104'),
      ],
      3,
    );
    expect(tainted[0]!.complete).toBe(false);
    expect(tainted[0]!.sourceBars).toBe(3);
  });

  it('aggregates across interior gaps without inventing data', () => {
    // Minute 1 is missing; minute 3 proves the bucket closed anyway.
    const bars = [
      bar(0, '100', '101', { volume: '0.50000000' }),
      bar(2, '102', '103', { volume: '0.25000000' }),
      bar(3, '103', '104'),
    ];
    const aggregated = aggregateBars(bars, 3);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.volume).toBe('0.75000000');
    expect(aggregated[0]!.tradeCount).toBe(2);
  });
});

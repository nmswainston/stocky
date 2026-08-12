import { describe, expect, it } from 'vitest';
import { aggregateBars } from '../backtest/aggregate.js';
import { bar } from '../backtest/testing/fixtures.js';
import { createBarFolder } from './fold.js';

const minutes = (count: number) => Array.from({ length: count }, (_, i) => bar(i, '100', '101'));

describe('createBarFolder', () => {
  it('chunked pushes emit exactly the one-shot aggregation, whatever the chunking', () => {
    const raw = minutes(47);
    const expected = aggregateBars(raw, 15);
    for (const chunkSize of [1, 4, 15, 47]) {
      const folder = createBarFolder(15, null);
      const emitted = [];
      for (let i = 0; i < raw.length; i += chunkSize) {
        emitted.push(...folder.push(raw.slice(i, i + chunkSize)));
      }
      expect(emitted).toEqual(expected);
    }
  });

  it('holds the trailing bucket until its period is proven over', () => {
    const folder = createBarFolder(15, null);
    // 00:00..00:13: the closing minute is absent and nothing lies beyond.
    expect(folder.push(minutes(14))).toEqual([]);
    const emitted = folder.push([bar(14, '100', '101')]);
    expect(emitted.map((b) => b.bucketStart)).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('ignores overlapping refetches instead of re-emitting', () => {
    const raw = minutes(31);
    const folder = createBarFolder(15, null);
    expect(folder.push(raw).map((b) => b.bucketStart)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:15:00.000Z',
    ]);
    expect(folder.push(raw)).toEqual([]);
  });

  it('resume skips buckets the session already processed', () => {
    const raw = minutes(46);
    const folder = createBarFolder(15, '2026-01-01T00:00:00.000Z');
    expect(folder.push(raw).map((b) => b.bucketStart)).toEqual([
      '2026-01-01T00:15:00.000Z',
      '2026-01-01T00:30:00.000Z',
    ]);
  });

  it('passes 1m bars through, deduplicating overlap', () => {
    const folder = createBarFolder(1, null);
    expect(folder.push(minutes(3))).toHaveLength(3);
    expect(folder.push(minutes(4))).toHaveLength(1);
  });
});

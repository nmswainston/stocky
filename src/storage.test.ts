import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Storage } from './storage.js';

// Integration tests against a real temporary DuckDB file: the
// completeness column, its default, and the never-downgrade rule for
// crash-recovered bars. Tests in this file run in order and share one
// database handle, since DuckDB allows a single writer.

const directory = mkdtempSync(path.join(tmpdir(), 'stocky-storage-'));
const databasePath = path.join(directory, 'test.duckdb');
let storage: Storage;

const bar = (minute: number, close: string, extra: Record<string, unknown> = {}) => ({
  symbol: 'TEST-USD',
  bucketStart: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  open: close,
  high: close,
  low: close,
  close,
  volume: '1.00000000',
  tradeCount: 1,
  ...extra,
});

describe('storage bar completeness', () => {
  beforeAll(async () => {
    storage = await Storage.open(databasePath);
  });

  afterAll(async () => {
    await storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores and round-trips the complete flag, defaulting to true', async () => {
    await storage.upsertBars([
      bar(0, '100'),
      bar(1, '101', { complete: false }),
      bar(2, '102', { complete: true }),
    ]);
    const bars = await storage.readBars('TEST-USD');
    expect(bars.map((b) => b.complete)).toEqual([true, false, true]);
  });

  it('insertBarsIfAbsent never downgrades an existing bar', async () => {
    // Bar 1 exists; a recovery attempt for it must be a no-op, while
    // bar 5 is genuinely absent and gets inserted marked incomplete.
    const inserted = await storage.insertBarsIfAbsent([
      bar(1, '999', { complete: false }),
      bar(5, '105', { complete: false }),
    ]);
    expect(inserted).toBe(1);
    const bars = await storage.readBars('TEST-USD');
    expect(bars).toHaveLength(4);
    const barOne = bars.find((b) => b.bucketStart.startsWith('2026-01-01T00:01'));
    expect(barOne!.close).toBe('101.00000000');
    const barFive = bars.find((b) => b.bucketStart.startsWith('2026-01-01T00:05'));
    expect(barFive!.complete).toBe(false);
  });

  it('upsert can promote a recovered bar once real data confirms it', async () => {
    await storage.upsertBars([bar(5, '105', { complete: true })]);
    const bars = await storage.readBars('TEST-USD');
    const barFive = bars.find((b) => b.bucketStart.startsWith('2026-01-01T00:05'));
    expect(barFive!.complete).toBe(true);
  });
});

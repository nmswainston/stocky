import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequestHandler, type ApiDependencies } from '../api/routes.js';
import { listResearchDays, readResearchDay } from './library.js';
import type { Snapshot, Thesis } from './types.js';

let directory: string;

function thesis(symbol: string, score: number, overrides: Partial<Thesis> = {}): Thesis {
  return {
    symbol,
    score,
    confidence: 'medium',
    summary: `${symbol} summary.`,
    bull: [{ point: 'Up on volume.', sources: [`price:${symbol}`, 'news:1'] }],
    bear: [{ point: 'Same headline again.', sources: ['news:1', 'news:gone'] }],
    watchFor: ['earnings'],
    verified: true,
    problems: [],
    ...overrides,
  };
}

function snapshot(symbol: string): Snapshot {
  return {
    symbol,
    companyName: `${symbol} Inc.`,
    asOf: '2026-09-01T12:30:00.000Z',
    features: {
      lastClose: 101.5,
      lastDate: '2026-08-31',
      return5d: 0.01,
      return20d: 0.04,
      return60d: 0.1,
      vsBenchmark20d: 0.02,
      volatility20d: 0.015,
      distanceFromSma50: 0.03,
      volumeRatio20d: 1.4,
      belowWindowHigh: 0.02,
    },
    recentCloses: [],
    news: [],
    filings: [],
    facts: [],
    sources: [
      { id: `price:${symbol}`, kind: 'price', label: `${symbol} daily prices` },
      { id: 'news:1', kind: 'news', label: 'A headline', url: 'https://example.com/a' },
      { id: 'news:2', kind: 'news', label: 'Sneaky', url: 'javascript:alert(1)' },
    ],
    dataProblems: [],
  };
}

async function writeDay(date: string, run: object, theses?: Thesis[], snapshots?: Snapshot[]) {
  const folder = path.join(directory, date);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'run.json'), JSON.stringify(run));
  if (theses) await writeFile(path.join(folder, 'theses.json'), JSON.stringify(theses));
  if (snapshots) await writeFile(path.join(folder, 'snapshots.json'), JSON.stringify(snapshots));
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'stocky-research-'));
  const watchlist = [
    {
      symbol: 'AAA',
      companyName: 'AAA Inc.',
      features: snapshot('AAA').features,
      interest: 3.2,
      newNews: 2,
      newFilings: [],
      researched: true,
      dataProblems: [],
    },
  ];
  await writeDay(
    '2026-09-01',
    { asOf: '2026-09-01T12:30:00.000Z', model: 'claude-sonnet-5-5', dryRun: false, costUsd: 0.12, budgetUsd: 0.75, skipped: [], watchlist },
    [thesis('BBB', -2), thesis('AAA', 3)],
    [snapshot('AAA'), snapshot('BBB')],
  );
  await writeDay('2026-08-31', { dryRun: true, costUsd: 0, watchlist }, []);
  // Not a date, and a date folder with no run.json: both ignored.
  await mkdir(path.join(directory, 'cache'), { recursive: true });
  await mkdir(path.join(directory, '2026-08-30'), { recursive: true });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('research library', () => {
  it('lists saved days newest first and skips everything else', async () => {
    const days = await listResearchDays(directory);
    expect(days.map((day) => [day.date, day.dryRun, day.thesisCount])).toEqual([
      ['2026-09-01', false, 2],
      ['2026-08-31', true, 0],
    ]);
  });

  it('returns no days when the folder does not exist yet', async () => {
    expect(await listResearchDays(path.join(directory, 'missing'))).toEqual([]);
  });

  it('joins theses with their snapshot, highest score first', async () => {
    const day = await readResearchDay(directory, '2026-09-01');
    expect(day?.theses.map((item) => item.symbol)).toEqual(['AAA', 'BBB']);
    const top = day!.theses[0]!;
    expect(top.companyName).toBe('AAA Inc.');
    expect(top.lastClose).toBe(101.5);
    expect(day?.watchlist[0]?.return20d).toBe(0.04);
    expect(day?.costUsd).toBe(0.12);
  });

  it('numbers each source once per thesis, in order of first use', async () => {
    const top = (await readResearchDay(directory, '2026-09-01'))!.theses[0]!;
    expect(top.bull[0]?.cites).toEqual([1, 2]);
    expect(top.bear[0]?.cites).toEqual([2, 3]);
    expect(top.sources.map((source) => [source.n, source.label, source.url])).toEqual([
      [1, 'AAA daily prices', null],
      [2, 'A headline', 'https://example.com/a'],
      // Unknown ids still show, by id, so a citation never silently vanishes.
      [3, 'news:gone', null],
    ]);
  });

  it('drops links that are not plain web links', async () => {
    const day = await readResearchDay(directory, '2026-09-01');
    const cited = thesis('AAA', 1, { bull: [{ point: 'x', sources: ['news:2'] }], bear: [] });
    await writeDay('2026-09-02', { dryRun: false }, [cited], [snapshot('AAA')]);
    const link = (await readResearchDay(directory, '2026-09-02'))!.theses[0]!.sources[0]!;
    expect(link.url).toBeNull();
    expect(day).not.toBeNull();
  });

  it('marks new finds and reads older days as watchlist only', async () => {
    const old = await readResearchDay(directory, '2026-09-01');
    expect(old?.discovery).toBeNull();
    expect(old?.watchlist[0]?.discovered).toBe(false);
    expect(old?.theses.every((item) => item.discovered === false)).toBe(true);

    const rows = [
      { symbol: 'AAA', companyName: 'AAA Inc.', features: null, interest: 1, newNews: 0, newFilings: [], researched: false, dataProblems: [], discovered: false, discoveryReason: null },
      { symbol: 'NEW', companyName: 'New Co', features: null, interest: 4, newNews: 3, newFilings: ['8-K'], researched: true, dataProblems: [], discovered: true, discoveryReason: '5 day move +9.0%' },
    ];
    await writeDay(
      '2026-09-03',
      { dryRun: false, watchlist: rows, discovery: { scanned: 100, liquid: 96, secChecked: 25, added: ['NEW'], problems: [] } },
      [thesis('NEW', 2)],
      [snapshot('NEW')],
    );
    const day = await readResearchDay(directory, '2026-09-03');
    expect(day?.discovery).toEqual({ scanned: 100, liquid: 96, added: ['NEW'] });
    expect(day?.theses[0]?.discovered).toBe(true);
    expect(day?.watchlist.map((row) => [row.symbol, row.discovered, row.discoveryReason])).toEqual([
      ['AAA', false, null],
      ['NEW', true, '5 day move +9.0%'],
    ]);
  });

  it('refuses anything that is not a date', async () => {
    expect(await readResearchDay(directory, '../etc')).toBeNull();
    expect(await readResearchDay(directory, '2026-01-01')).toBeNull();
  });
});

describe('research API routes', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const unused = async () => [];
    const deps: ApiDependencies = {
      snapshot: () => ({
        uptimeSeconds: 0,
        connected: false,
        messagesReceived: 0,
        lastMessageAt: null,
        reconnectCount: 0,
        gapCount: 0,
        duplicatesSkipped: 0,
        lateTrades: 0,
        buffered: 0,
        tradesWritten: 0,
        barsWritten: 0,
      }),
      readBars: unused,
      readTicker: unused,
      readRecentTrades: unused,
      readHealth: async () => ({}),
      publicDirectory: directory,
      backtestsDirectory: directory,
      paperDirectory: directory,
      digestsDirectory: directory,
      researchDirectory: directory,
      vendorFiles: {},
    };
    server = http.createServer(createRequestHandler(deps));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves the day list and one day', async () => {
    const list = (await (await fetch(`${base}/api/research`)).json()) as { days: { date: string }[] };
    expect(list.days[0]?.date).toBe('2026-09-03');
    const day = await fetch(`${base}/api/research/2026-09-01`);
    expect(day.status).toBe(200);
    expect(((await day.json()) as { theses: unknown[] }).theses).toHaveLength(2);
  });

  it('answers 404 for a missing day and refuses writes', async () => {
    expect((await fetch(`${base}/api/research/2020-01-01`)).status).toBe(404);
    expect((await fetch(`${base}/api/research`, { method: 'POST' })).status).toBe(405);
  });
});

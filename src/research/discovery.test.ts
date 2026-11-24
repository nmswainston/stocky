import { describe, expect, it } from 'vitest';
import type { ThesisReply, ThesisWriter } from './agent.js';
import { researchConfig, type ResearchConfig } from './config.js';
import { discover, type DiscoverySources } from './discovery.js';
import { renderDigest } from './render.js';
import { runResearch, type RunSources } from './run.js';
import { dailyBars, newsItem, rampCloses } from './testing/fixtures.js';
import type { DailyBar, NewsItem } from './types.js';

const NOW = new Date('2026-09-01T13:00:00.000Z');

// 80 sessions ending the day before NOW, so nothing looks stale.
function recent(closes: number[], volume = 1_000_000): DailyBar[] {
  const start = new Date(Date.parse('2026-08-31T00:00:00Z') - (closes.length - 1) * 86_400_000);
  return dailyBars(closes, start.toISOString().slice(0, 10), volume);
}

const jump = (from: number) => [...rampCloses(75, from, 0.1), from * 1.1, from * 1.2, from * 1.3, from * 1.4, from * 1.5];
const calm = (price: number) => Array.from({ length: 80 }, (_, index) => (index % 2 === 0 ? price : price * 1.02));

const BARS: Record<string, DailyBar[]> = {
  SPY: recent(rampCloses(80, 400, 1)),
  BIG: recent(jump(100)),
  CALM: recent(calm(50)),
  PENNY: recent(jump(4)), // big move, but a $6 stock
  THIN: recent(jump(100), 100), // big move, almost no trading
  STALE: dailyBars(jump(100), '2026-04-01'), // last bar in June
  MINE: recent(jump(100)), // on the watchlist already
};

function config(discovery: Partial<ResearchConfig['discovery']> = {}, overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  const base = researchConfig();
  return {
    ...base,
    watchlist: ['MINE'],
    ...overrides,
    discovery: {
      ...base.discovery,
      universe: ['BIG', 'CALM', 'PENNY', 'THIN', 'STALE', 'MINE'],
      ...discovery,
    },
  };
}

function scanSources(
  bars: Record<string, DailyBar[]>,
  extra: { news?: NewsItem[]; filings?: Record<string, string[]> } = {},
) {
  const barCalls: string[][] = [];
  const companyCalls: string[] = [];
  const sources: DiscoverySources = {
    async dailyBars(symbols) {
      barCalls.push(symbols);
      return new Map(symbols.filter((symbol) => bars[symbol]).map((symbol) => [symbol, bars[symbol] as DailyBar[]]));
    },
    async company(symbol) {
      companyCalls.push(symbol);
      return { cik: symbol.charCodeAt(0), title: `${symbol} Inc.` };
    },
    async filings(cik) {
      const symbol = Object.keys(extra.filings ?? {}).find((name) => name.charCodeAt(0) === cik);
      return (symbol ? extra.filings?.[symbol] ?? [] : []).map((form) => ({ form, filedOn: '2026-08-31' }));
    },
  };
  if (extra.news) {
    const items = extra.news;
    sources.recentNews = async () => items;
  }
  return { sources, barCalls, companyCalls };
}

function story(id: string, symbol: string, createdAt = '2026-08-31T20:00:00Z'): NewsItem {
  return { ...newsItem(id, createdAt), symbols: [symbol] };
}

describe('discover', () => {
  it('keeps only large, liquid, still trading names off the watchlist', async () => {
    const { sources } = scanSources(BARS);
    const result = await discover(config(), sources, { now: NOW, exclude: ['MINE', 'SPY'], benchmarkBars: BARS.SPY! });
    expect(result.scanned).toBe(5);
    expect(result.liquid).toBe(2); // BIG and CALM
    expect(result.added.map((item) => item.symbol)).toEqual(['BIG']);
    expect(result.added[0]?.reason).toContain('5 day move +');
  });

  it('adds nothing on a quiet day', async () => {
    const { sources } = scanSources(BARS);
    const result = await discover(config({ universe: ['CALM'] }), sources, {
      now: NOW,
      exclude: [],
      benchmarkBars: BARS.SPY!,
    });
    expect(result.liquid).toBe(1);
    expect(result.added).toEqual([]);
  });

  it('asks for prices in batches and adds at most the configured number', async () => {
    const many: Record<string, DailyBar[]> = { ...BARS };
    const universe = Array.from({ length: 120 }, (_, index) => `S${index}`);
    for (const symbol of universe) many[symbol] = recent(jump(50 + universe.indexOf(symbol)));
    const { sources, barCalls } = scanSources(many);
    const result = await discover(config({ universe, add: 2 }), sources, {
      now: NOW,
      exclude: [],
      benchmarkBars: BARS.SPY!,
    });
    expect(barCalls.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(result.added).toHaveLength(2);
  });

  it('lets fresh news and an 8-K lift a quiet chart over the bar', async () => {
    const bars = { ...BARS, NEWSY: recent(calm(80)) };
    const news = [story('a', 'NEWSY'), story('b', 'NEWSY'), story('c', 'NEWSY'), story('old', 'CALM', '2026-08-20T10:00:00Z')];
    const { sources } = scanSources(bars, { news, filings: { NEWSY: ['8-K'] } });
    const result = await discover(config({ universe: ['NEWSY', 'CALM'] }), sources, {
      now: NOW,
      exclude: [],
      benchmarkBars: BARS.SPY!,
    });
    expect(result.added.map((item) => item.symbol)).toEqual(['NEWSY']);
    expect(result.added[0]?.reason).toContain('3 new stories');
    expect(result.added[0]?.reason).toContain('fresh 8-K');
  });

  it('checks SEC filings only for the busiest few', async () => {
    const many: Record<string, DailyBar[]> = { ...BARS };
    const universe = ['A1', 'A2', 'A3', 'A4', 'A5'];
    for (const symbol of universe) many[symbol] = recent(jump(60));
    const { sources, companyCalls } = scanSources(many);
    await discover(config({ universe, secChecks: 2 }), sources, { now: NOW, exclude: [], benchmarkBars: BARS.SPY! });
    expect(companyCalls).toHaveLength(2);
  });

  it('records a failed price batch instead of failing the run', async () => {
    const { sources } = scanSources(BARS);
    sources.dailyBars = async () => {
      throw new Error('rate limited');
    };
    const result = await discover(config(), sources, { now: NOW, exclude: [], benchmarkBars: BARS.SPY! });
    expect(result.added).toEqual([]);
    expect(result.problems.join(' ')).toContain('rate limited');
  });
});

function runSources(bars: Record<string, DailyBar[]>): RunSources & { barCalls: string[][] } {
  const barCalls: string[][] = [];
  return {
    barCalls,
    async dailyBars(symbols) {
      barCalls.push(symbols);
      return new Map(symbols.map((symbol) => [symbol, bars[symbol] ?? []]));
    },
    async news(symbol) {
      return [newsItem(`${symbol}-new`, '2026-08-31T22:00:00Z')];
    },
    async company(symbol) {
      return { cik: 1, title: `${symbol} Inc.` };
    },
    async filings() {
      return [];
    },
    async facts() {
      return [];
    },
  };
}

function writer(): ThesisWriter {
  return {
    async write(prompt): Promise<ThesisReply> {
      const symbol = /Write the thesis for (\S+)\./.exec(prompt)?.[1] ?? '';
      return {
        json: {
          score: 2,
          confidence: 'medium',
          summary: `About ${symbol}.`,
          bull: [{ point: 'Price is rising.', sources: [`price:${symbol}`] }],
          bear: [],
          watch_for: [],
        },
        usage: { input_tokens: 4_000, output_tokens: 1_000 },
        stopReason: 'end_turn',
      };
    },
  };
}

describe('runResearch with discovery', () => {
  const watch = { watchlist: ['MINE', 'CALM'] };

  it('adds discovered names to the day, marked, under the same daily limit', async () => {
    const result = await runResearch(config({ universe: ['BIG', 'PENNY'] }, watch), runSources(BARS), writer(), {
      now: NOW,
      limit: 2,
    });
    const big = result.rows.find((row) => row.symbol === 'BIG');
    expect(big?.discovered).toBe(true);
    expect(big?.discoveryReason).toContain('5 day move');
    expect(result.rows.find((row) => row.symbol === 'MINE')?.discovered).toBe(false);
    expect(result.rows.some((row) => row.symbol === 'PENNY')).toBe(false);
    expect(result.theses).toHaveLength(2);
    expect(result.discovery?.added).toEqual(['BIG']);

    const digest = renderDigest(result);
    expect(digest).toContain('## New finds');
    expect(digest).toContain('- BIG (BIG Inc.): 5 day move');
    expect(digest).toContain('new find');
  });

  it('skips the wider scan for a hand-picked --symbols run or when switched off', async () => {
    const narrow = runSources(BARS);
    const picked = await runResearch(config(), narrow, null, { now: NOW, symbols: ['MINE'] });
    expect(picked.discovery).toBeNull();
    expect(narrow.barCalls).toHaveLength(1);

    const off = runSources(BARS);
    const result = await runResearch(config({ enabled: false }, watch), off, null, { now: NOW });
    expect(result.discovery).toBeNull();
    expect(off.barCalls).toHaveLength(1);
    expect(renderDigest(result)).not.toContain('## New finds');
  });
});

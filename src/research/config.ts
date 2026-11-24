// Settings for the stock research digest (phase 1 of the stocks plan).
// Research only: nothing in src/research can place, change or cancel
// an order. The guard test in no-orders.test.ts keeps it that way.

import { LARGE_CAP_UNIVERSE } from './universe.js';

const DEFAULT_WATCHLIST = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL',
  'META', 'AVGO', 'TSLA', 'JPM', 'V',
  'MA', 'UNH', 'LLY', 'COST', 'WMT',
  'HD', 'XOM', 'JNJ', 'PG', 'NFLX',
];

function listFromEnv(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return null;
  return raw
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
}

function switchFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['on', 'true', 'yes', '1'].includes(raw)) return true;
  if (['off', 'false', 'no', '0'].includes(raw)) return false;
  throw new Error(`${name} must be on or off, got ${process.env[name]}`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${raw}`);
  }
  return value;
}

// Read lazily so tests and the CLI can set process.env first.
export function researchConfig() {
  return {
    watchlist: listFromEnv('STOCKY_WATCHLIST') ?? DEFAULT_WATCHLIST,
    // Relative strength and the digest's market line are measured against this.
    benchmark: 'SPY',
    // Only the most interesting names get a Claude write-up each day;
    // the rest still appear in the digest with their numbers.
    researchPerDay: Math.round(numberFromEnv('RESEARCH_PER_DAY', 8)),
    // Hard daily cap on Claude spend, in US dollars. Research stops for
    // the day once the next call could cross it.
    dailyBudgetUsd: numberFromEnv('RESEARCH_DAILY_BUDGET_USD', 0.75),
    // Before the daily pick, scan a wider list of large US stocks and add
    // the few where something unusual happened. Discovered names compete
    // for the same researchPerDay slots and the same daily budget, so
    // discovery never raises the Claude bill past the cap.
    discovery: {
      enabled: switchFromEnv('RESEARCH_DISCOVERY', true),
      // At most this many discovered names join the day's list.
      add: Math.round(numberFromEnv('RESEARCH_DISCOVERY_ADD', 3)),
      universe: listFromEnv('STOCKY_DISCOVERY_UNIVERSE') ?? LARGE_CAP_UNIVERSE,
      // No penny stocks: last close at least this many dollars.
      minPrice: 10,
      // Average daily dollar volume over 20 sessions, as seen on Alpaca's
      // free IEX feed. IEX carries only a few percent of all US trading,
      // so $2M there is roughly $50M or more across the whole market.
      minDollarVolume: 2_000_000,
      // Same scale as the watchlist's interest score. 2 is about a two
      // sigma five day move, or a smaller move with heavy volume and news.
      minInterest: numberFromEnv('RESEARCH_DISCOVERY_MIN_INTEREST', 2),
      // SEC filing checks per run, on the names already looking busiest.
      // Keeps EDGAR traffic small; each answer is cached for 20 hours.
      secChecks: 25,
      // Cap on the one bulk news query across the whole liquid list.
      newsItems: 200,
      // Alpaca bars requests carry at most this many symbols.
      batchSize: 50,
    },
    model: process.env.RESEARCH_MODEL ?? 'claude-sonnet-5-5',
    effort: 'medium' as const,
    maxOutputTokens: 6_000,
    history: {
      // Calendar days of daily bars to pull: enough for a 50 day average.
      barDays: 120,
      newsDays: 7,
      newsPerSymbol: 15,
      filingDays: 120,
      quarters: 5,
    },
    paths: {
      researchDirectory: 'data/research',
      // Same folder as the crypto digest, so the existing dashboard lists
      // research digests in its Daily digest picker with no UI changes.
      digestsDirectory: 'data/digests',
      edgarCacheDirectory: 'data/research/cache/edgar',
    },
  };
}

export type ResearchConfig = ReturnType<typeof researchConfig>;

// Dollars per million tokens. Check https://www.anthropic.com/pricing
// before trusting these; the app logs the real usage of every call.
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

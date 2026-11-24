// Settings for the stock research digest (phase 1 of the stocks plan).
// Research only: nothing in src/research can place, change or cancel
// an order. The guard test in no-orders.test.ts keeps it that way.

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

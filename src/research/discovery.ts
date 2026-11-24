import type { ResearchConfig } from './config.js';
import { computeFeatures, interestScore } from './features.js';
import type { DailyBar, Features, NewsItem } from './types.js';

// Discovery: before the daily pick, scan a wider list of large US stocks
// and return the few where something unusual happened, so the research
// is not limited to a fixed watchlist. Plain math only, no Claude calls.
//
// Cheapest checks first, to stay well inside the free data limits:
//   1. daily bars for the whole list, a batch of symbols per request
//   2. drop anything cheap, thinly traded or no longer trading
//   3. one bulk news query across what is left
//   4. SEC filing checks only for the busiest few (EDGAR is paced and cached)
// Research only: it reads market data and filings and nothing else.

export interface DiscoverySources {
  dailyBars(symbols: string[], startDate: string, endIso: string): Promise<Map<string, DailyBar[]>>;
  company(symbol: string): Promise<{ cik: number; title: string } | null>;
  filings(cik: number, sinceDate: string, asOfDate: string): Promise<{ form: string; filedOn: string }[]>;
  // Optional: one news query for many symbols at once. Without it,
  // discovery ranks on price, volume and filings only.
  recentNews?(symbols: string[], startIso: string, endIso: string, max: number): Promise<NewsItem[]>;
}

export interface Discovered {
  symbol: string;
  interest: number;
  reason: string;
}

export interface DiscoveryResult {
  scanned: number; // names in the list after removing the watchlist
  liquid: number; // names that passed the price, volume and freshness checks
  secChecked: number;
  added: Discovered[];
  bars: Map<string, DailyBar[]>; // bars already fetched, reused by the run
  problems: string[];
}

const DAY_MS = 86_400_000;
const STALE_DAYS = 7; // no bar in a week: halted, delisted or renamed

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function averageDollarVolume(bars: DailyBar[], sessions: number): number {
  const recent = bars.slice(-sessions);
  if (recent.length === 0) return 0;
  return recent.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / recent.length;
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

export function discoveryReason(features: Features, newNews: number, newFilings: string[]): string {
  const parts: string[] = [];
  if (features.return5d !== null) parts.push(`5 day move ${pct(features.return5d)}`);
  if (features.volumeRatio20d !== null && features.volumeRatio20d >= 1.5) {
    parts.push(`volume ${features.volumeRatio20d.toFixed(1)}x normal`);
  }
  if (newNews > 0) parts.push(`${newNews} new ${newNews === 1 ? 'story' : 'stories'}`);
  const forms = [...new Set(newFilings.filter((form) => form === '8-K' || form.startsWith('10-')))];
  if (forms.length > 0) parts.push(`fresh ${forms.join(', ')}`);
  return parts.join(', ');
}

export async function discover(
  config: ResearchConfig,
  sources: DiscoverySources,
  options: {
    now: Date;
    exclude: string[];
    benchmarkBars: DailyBar[];
    log?: (line: string) => void;
  },
): Promise<DiscoveryResult> {
  const log = options.log ?? (() => {});
  const d = config.discovery;
  const asOf = options.now.toISOString();
  const asOfDate = asOf.slice(0, 10);
  const excluded = new Set(options.exclude.map((symbol) => symbol.toUpperCase()));
  const universe = [...new Set(d.universe.map((symbol) => symbol.toUpperCase()))].filter(
    (symbol) => !excluded.has(symbol),
  );
  const problems: string[] = [];
  const result: DiscoveryResult = { scanned: universe.length, liquid: 0, secChecked: 0, added: [], bars: new Map(), problems };
  if (d.add <= 0 || universe.length === 0) return result;

  // 1. Bars, in batches so each request stays small.
  const start = new Date(options.now.getTime() - config.history.barDays * DAY_MS).toISOString().slice(0, 10);
  const batchSize = Math.max(1, d.batchSize);
  for (let index = 0; index < universe.length; index += batchSize) {
    const batch = universe.slice(index, index + batchSize);
    try {
      const bars = await sources.dailyBars(batch, start, asOf);
      for (const [symbol, list] of bars) result.bars.set(symbol, list);
    } catch (error) {
      problems.push(`prices unavailable for ${batch.length} names: ${message(error)}`);
    }
  }
  log(`discovery: prices for ${result.bars.size} of ${universe.length} names`);

  // 2. Large and liquid only, and still trading.
  const staleBefore = new Date(options.now.getTime() - STALE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const liquid: { symbol: string; features: Features }[] = [];
  for (const symbol of universe) {
    const bars = result.bars.get(symbol) ?? [];
    if (bars.length < 25) continue;
    const last = bars[bars.length - 1] as DailyBar;
    if (last.date < staleBefore) continue;
    if (last.close < d.minPrice) continue;
    if (averageDollarVolume(bars, 20) < d.minDollarVolume) continue;
    const features = computeFeatures(bars, options.benchmarkBars);
    if (features) liquid.push({ symbol, features });
  }
  result.liquid = liquid.length;
  if (liquid.length === 0) return result;

  // 3. One bulk news query: how many fresh stories mention each name.
  const newsCutoff = new Date(options.now.getTime() - 1.5 * DAY_MS).toISOString();
  const newsCount = new Map<string, number>();
  if (sources.recentNews) {
    try {
      const items = await sources.recentNews(
        liquid.map((item) => item.symbol),
        newsCutoff,
        asOf,
        d.newsItems,
      );
      for (const item of items) {
        if (item.createdAt < newsCutoff || item.createdAt >= asOf) continue;
        for (const symbol of new Set(item.symbols.map((value) => value.toUpperCase()))) {
          newsCount.set(symbol, (newsCount.get(symbol) ?? 0) + 1);
        }
      }
    } catch (error) {
      problems.push(`news scan unavailable: ${message(error)}`);
    }
  }

  const ranked = liquid
    .map((item) => {
      const newNews = newsCount.get(item.symbol) ?? 0;
      return {
        ...item,
        newNews,
        newFilings: [] as string[],
        score: interestScore({ features: item.features, newNewsCount: newNews, newFilingForms: [] }),
      };
    })
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  // 4. Fresh filings, only for the names already looking busiest.
  const filingCutoff = new Date(options.now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10);
  for (const item of ranked.slice(0, Math.max(0, d.secChecks))) {
    try {
      const company = await sources.company(item.symbol);
      result.secChecked += 1;
      if (!company) continue;
      const filings = await sources.filings(company.cik, filingCutoff, asOfDate);
      item.newFilings = filings.filter((filing) => filing.filedOn >= filingCutoff).map((filing) => filing.form);
      item.score = interestScore({ features: item.features, newNewsCount: item.newNews, newFilingForms: item.newFilings });
    } catch (error) {
      problems.push(`${item.symbol}: SEC check unavailable: ${message(error)}`);
    }
  }

  result.added = ranked
    .filter((item) => item.score >= d.minInterest)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, d.add)
    .map((item) => ({
      symbol: item.symbol,
      interest: item.score,
      reason: discoveryReason(item.features, item.newNews, item.newFilings),
    }));
  log(`discovery: ${liquid.length} liquid, adding ${result.added.map((item) => item.symbol).join(', ') || 'nothing'}`);
  return result;
}

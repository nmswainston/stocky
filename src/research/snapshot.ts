import { computeFeatures } from './features.js';
import type { DailyBar, Filing, NewsItem, QuarterFact, Snapshot, SourceRef } from './types.js';

// Everything Claude may look at for one symbol, frozen at asOf. Each
// fact gets a source id, and a thesis point only counts if it cites ids
// that exist here. That is the hallucination check: a claim with no
// matching row in the snapshot is dropped, not trusted.

export function buildSnapshot(input: {
  symbol: string;
  companyName: string | null;
  asOf: string;
  bars: DailyBar[];
  benchmarkBars: DailyBar[];
  news: NewsItem[];
  filings: Filing[];
  facts: QuarterFact[];
  dataProblems?: string[];
}): Snapshot {
  const asOfDate = input.asOf.slice(0, 10);
  // Lookahead guard: drop anything stamped at or after asOf, even if a
  // data source handed it over.
  const bars = input.bars.filter((bar) => bar.date < asOfDate);
  const benchmarkBars = input.benchmarkBars.filter((bar) => bar.date < asOfDate);
  const news = input.news.filter((item) => item.createdAt < input.asOf);
  const filings = input.filings.filter((filing) => filing.filedOn < asOfDate);
  const facts = input.facts.filter((fact) => fact.filedOn < asOfDate);
  const problems = [...(input.dataProblems ?? [])];
  if (bars.length === 0) problems.push('no daily bars');
  else if (bars.length < 50) problems.push(`only ${bars.length} daily bars`);

  const sources: SourceRef[] = [];
  const features = computeFeatures(bars, benchmarkBars);
  if (features) {
    sources.push({
      id: `price:${input.symbol}`,
      kind: 'price',
      label: `${input.symbol} daily bars through ${features.lastDate} (Alpaca IEX)`,
    });
  }
  for (const item of news) {
    sources.push({ id: `news:${item.id}`, kind: 'news', label: `${item.source}: ${item.headline}`, url: item.url });
  }
  for (const filing of filings) {
    sources.push({
      id: `filing:${filing.accession}`,
      kind: 'filing',
      label: `${filing.form} filed ${filing.filedOn}`,
      url: filing.url,
    });
  }
  for (const fact of facts) {
    sources.push({
      id: `fact:${fact.concept}:${fact.periodEnd}`,
      kind: 'fact',
      label: `${fact.concept} for the quarter ending ${fact.periodEnd} (${fact.form})`,
    });
  }

  return {
    symbol: input.symbol,
    companyName: input.companyName,
    asOf: input.asOf,
    features,
    recentCloses: bars.slice(-10).map((bar) => ({ date: bar.date, close: bar.close })),
    news,
    filings,
    facts,
    sources,
    dataProblems: problems,
  };
}

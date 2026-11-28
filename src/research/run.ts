import type { ThesisWriter } from './agent.js';
import type { ResearchConfig } from './config.js';
import { Budget, estimateTokens } from './cost.js';
import { discover, type DiscoveryResult } from './discovery.js';
import { interestScore, pickForResearch } from './features.js';
import { priorForPrompt, snapshotForPrompt, SYSTEM_PROMPT } from './prompt.js';
import { buildSnapshot } from './snapshot.js';
import { validateThesis } from './thesis.js';
import type { DailyBar, Features, Filing, NewsItem, PriorThesis, QuarterFact, Snapshot, Thesis } from './types.js';

// One research run: collect, screen, research, validate. Every outside
// call comes in through RunSources so tests run offline, and nothing in
// here can reach a broker.

export interface RunSources {
  dailyBars(symbols: string[], startDate: string, endIso: string): Promise<Map<string, DailyBar[]>>;
  news(symbol: string, startIso: string, endIso: string, max: number): Promise<NewsItem[]>;
  company(symbol: string): Promise<{ cik: number; title: string } | null>;
  filings(cik: number, sinceDate: string, asOfDate: string): Promise<Filing[]>;
  facts(cik: number, asOfDate: string, quarters: number): Promise<QuarterFact[]>;
  // One news query across many symbols, used only by discovery.
  recentNews?(symbols: string[], startIso: string, endIso: string, max: number): Promise<NewsItem[]>;
}

export interface WatchRow {
  symbol: string;
  companyName: string | null;
  features: Features | null;
  interest: number;
  newNews: number;
  newFilings: string[];
  researched: boolean;
  dataProblems: string[];
  // True for names found by the wider scan rather than the watchlist.
  discovered: boolean;
  discoveryReason: string | null;
}

export interface DiscoverySummary {
  scanned: number;
  liquid: number;
  secChecked: number;
  added: string[];
  problems: string[];
}

export interface RunResult {
  marketDate: string;
  asOf: string;
  model: string;
  // The cheaper model picks past premiumPerDay were routed to, when
  // budget routing was on for this run.
  budgetModel: string | null;
  dryRun: boolean;
  budgetUsd: number;
  costUsd: number;
  tokens: { input: number; output: number };
  benchmark: { symbol: string; features: Features | null };
  rows: WatchRow[];
  // Null when discovery was off for this run.
  discovery: DiscoverySummary | null;
  theses: Thesis[];
  skipped: { symbol: string; reason: string }[];
  snapshots: Snapshot[];
  prompts: { symbol: string; prompt: string; estimatedTokens: number }[];
}

const DAY_MS = 86_400_000;

export function marketDateOf(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export async function runResearch(
  config: ResearchConfig,
  sources: RunSources,
  writer: ThesisWriter | null,
  options: {
    now: Date;
    symbols?: string[];
    limit?: number;
    discover?: boolean;
    // Most recent live thesis per symbol, shown back to the model so
    // today's write-up builds on its last one instead of starting cold.
    priorTheses?: Map<string, PriorThesis>;
    log?: (line: string) => void;
  },
): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const { now } = options;
  const asOf = now.toISOString();
  const asOfDate = asOf.slice(0, 10);
  const watchlist = options.symbols ?? config.watchlist;
  // A hand-picked --symbols run is a narrow test, so it skips discovery.
  const discoveryOn = options.discover ?? (config.discovery.enabled && options.symbols === undefined);
  const h = config.history;
  const recentNewsCutoff = daysBefore(now, 1.5);
  const recentFilingCutoff = daysBefore(now, 3).slice(0, 10);

  log(`collecting daily bars for ${watchlist.length} symbols plus ${config.benchmark}`);
  const allBars = await sources.dailyBars([...watchlist, config.benchmark], daysBefore(now, h.barDays).slice(0, 10), asOf);
  const benchmarkBars = allBars.get(config.benchmark) ?? [];

  let discovery: DiscoveryResult | null = null;
  if (discoveryOn) {
    discovery = await discover(config, sources, {
      now,
      exclude: [...watchlist, config.benchmark],
      benchmarkBars,
      log,
    });
    for (const item of discovery.added) allBars.set(item.symbol, discovery.bars.get(item.symbol) ?? []);
  }
  const discoveredReasons = new Map((discovery?.added ?? []).map((item) => [item.symbol, item.reason]));
  const symbols = [...watchlist, ...discoveredReasons.keys()];

  const snapshots: Snapshot[] = [];
  const rows: WatchRow[] = [];
  for (const symbol of symbols) {
    const problems: string[] = [];
    let news: NewsItem[] = [];
    let filings: Filing[] = [];
    let facts: QuarterFact[] = [];
    let companyName: string | null = null;
    try {
      news = await sources.news(symbol, daysBefore(now, h.newsDays), asOf, h.newsPerSymbol);
    } catch (error) {
      problems.push(`news unavailable: ${message(error)}`);
    }
    try {
      const company = await sources.company(symbol);
      if (company) {
        companyName = company.title;
        filings = await sources.filings(company.cik, daysBefore(now, h.filingDays).slice(0, 10), asOfDate);
        facts = await sources.facts(company.cik, asOfDate, h.quarters);
      } else {
        problems.push('not found in SEC ticker list');
      }
    } catch (error) {
      problems.push(`SEC data unavailable: ${message(error)}`);
    }
    const snapshot = buildSnapshot({
      symbol,
      companyName,
      asOf,
      bars: allBars.get(symbol) ?? [],
      benchmarkBars,
      news,
      filings,
      facts,
      dataProblems: problems,
    });
    snapshots.push(snapshot);
    const newNews = snapshot.news.filter((item) => item.createdAt >= recentNewsCutoff).length;
    const newFilings = snapshot.filings
      .filter((filing) => filing.filedOn >= recentFilingCutoff)
      .map((filing) => filing.form);
    rows.push({
      symbol,
      companyName,
      features: snapshot.features,
      interest: interestScore({ features: snapshot.features, newNewsCount: newNews, newFilingForms: newFilings }),
      newNews,
      newFilings,
      researched: false,
      dataProblems: snapshot.dataProblems,
      discovered: discoveredReasons.has(symbol),
      discoveryReason: discoveredReasons.get(symbol) ?? null,
    });
  }

  const picked = pickForResearch(
    rows
      .filter((row) => row.features !== null)
      .map((row) => ({
        symbol: row.symbol,
        score: row.interest,
        // A fresh quarterly or annual report on a watchlist name always
        // earns a look. Discovered names compete on score, so earnings
        // season elsewhere cannot crowd out the names you chose.
        mustResearch: !row.discovered && row.newFilings.some((form) => form.startsWith('10-')),
      })),
    options.limit ?? config.researchPerDay,
  );
  log(`screen picked ${picked.join(', ') || 'nothing'}`);

  const budget = new Budget(config.dailyBudgetUsd, config.model, [config.budgetModel]);
  const theses: Thesis[] = [];
  const skipped: RunResult['skipped'] = [];
  const prompts: RunResult['prompts'] = [];
  const tokens = { input: 0, output: 0 };
  const systemTokens = estimateTokens(SYSTEM_PROMPT);

  // Prior performance sees only bars strictly before the as-of date,
  // the cutoff buildSnapshot already applies, so an as-of replay can
  // never leak the replay day's close into its own prompt.
  const beforeAsOf = (list: DailyBar[]): DailyBar[] => list.filter((bar) => bar.date < asOfDate);

  for (const [index, symbol] of picked.entries()) {
    // Budget routing: the first premiumPerDay picks (forced filings,
    // then highest interest) get the premium model, the rest the cheap
    // one. With no budget model configured, every pick is premium.
    const model = config.budgetModel && index >= config.premiumPerDay ? config.budgetModel : config.model;
    const snapshot = snapshots.find((item) => item.symbol === symbol) as Snapshot;
    const prior = options.priorTheses?.get(symbol);
    const prompt = snapshotForPrompt(
      snapshot,
      prior ? priorForPrompt(prior, beforeAsOf(allBars.get(symbol) ?? []), beforeAsOf(benchmarkBars)) : null,
    );
    const estimatedTokens = systemTokens + estimateTokens(prompt);
    prompts.push({ symbol, prompt, estimatedTokens });
    if (!writer) continue; // dry run: build prompts, call nothing
    if (!budget.canAfford(estimatedTokens, config.maxOutputTokens, model)) {
      skipped.push({ symbol, reason: `daily budget of $${config.dailyBudgetUsd.toFixed(2)} reached` });
      continue;
    }
    try {
      log(`researching ${symbol} with ${model}`);
      const reply = await writer.write(prompt, model);
      const cost = budget.record(reply.usage, model);
      tokens.input += reply.usage.input_tokens;
      tokens.output += reply.usage.output_tokens;
      const thesis = validateThesis(reply.json, snapshot);
      thesis.model = model;
      if (reply.json === null) {
        thesis.problems.unshift(`no usable answer (stop reason ${reply.stopReason ?? 'unknown'})`);
        thesis.verified = false;
      }
      theses.push(thesis);
      const row = rows.find((item) => item.symbol === symbol);
      if (row) row.researched = true;
      log(`${symbol}: score ${thesis.score}, ${thesis.confidence} confidence, $${cost.toFixed(4)}`);
    } catch (error) {
      skipped.push({ symbol, reason: `Claude call failed: ${message(error)}` });
    }
  }

  const benchmarkSnapshot = buildSnapshot({
    symbol: config.benchmark,
    companyName: null,
    asOf,
    bars: benchmarkBars,
    benchmarkBars: [],
    news: [],
    filings: [],
    facts: [],
  });

  return {
    marketDate: marketDateOf(now),
    asOf,
    model: config.model,
    budgetModel: config.budgetModel,
    dryRun: writer === null,
    budgetUsd: config.dailyBudgetUsd,
    costUsd: budget.spent,
    tokens,
    benchmark: { symbol: config.benchmark, features: benchmarkSnapshot.features },
    rows,
    discovery: discovery
      ? {
          scanned: discovery.scanned,
          liquid: discovery.liquid,
          secChecked: discovery.secChecked,
          added: discovery.added.map((item) => item.symbol),
          problems: discovery.problems,
        }
      : null,
    theses,
    skipped,
    snapshots,
    prompts,
  };
}

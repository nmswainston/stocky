import { computeFeatures, interestScore } from '../features.js';
import type { DailyBar, Features } from '../types.js';

// Price-only replay of the rule-based parts of the research pipeline.
//
// What it can answer: does the screen point at stocks that then move a
// lot (its only job), and does a simple rule-based score pick stocks
// that beat SPY? What it cannot answer: whether Claude's theses beat
// SPY. A model asked about 2024 already knows how 2024 ended, so any
// replayed thesis is contaminated. Those get graded forward instead, by
// scorecard.ts, on theses written before the outcome existed.
//
// Timing follows Stocky's no-lookahead rule: decide with bars strictly
// before session N, enter at session N's open, exit at the open
// `hold` sessions later.

export interface ReplayOptions {
  symbols: string[];
  benchmark: string;
  startDate: string;
  endDate: string;
  every: number; // sessions between decisions
  hold: number; // sessions each pick is held
  top: number; // picks per decision
  costBps: number; // round trip cost charged to each pick
}

export interface ReplayPeriod {
  date: string;
  exitDate: string;
  picks: { symbol: string; ruleScore: number; forward: number }[];
  screened: string[];
  benchmarkForward: number;
  universeForward: number; // equal weight, every eligible symbol
  picksForward: number; // equal weight picks, after costs
  screenedAbsMove: number;
  restAbsMove: number;
}

export interface ReplaySummary {
  periods: number;
  eligibleSymbols: number;
  picksVsBenchmark: number; // mean excess per period
  picksVsUniverse: number;
  hitRate: number; // share of periods the picks beat the benchmark
  picksGrowth: number; // compounded, non-overlapping periods only
  benchmarkGrowth: number;
  screenLift: number; // screened abs move / rest abs move
}

const MIN_HISTORY = 61;

// A deliberately plain directional baseline: trend relative to SPY plus
// position versus the 50 day average, scaled to -5..+5. If Claude cannot
// beat this in the forward test, Claude is not adding anything.
export function ruleScore(features: Features | null): number {
  if (!features) return 0;
  const raw = (features.vsBenchmark20d ?? 0) / 0.03 + (features.distanceFromSma50 ?? 0) / 0.05;
  return Math.max(-5, Math.min(5, Math.round(raw)));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function indexByDate(bars: DailyBar[]): Map<string, number> {
  return new Map(bars.map((bar, index) => [bar.date, index]));
}

export function replay(bars: Map<string, DailyBar[]>, options: ReplayOptions): { periods: ReplayPeriod[]; summary: ReplaySummary } {
  const benchmarkBars = bars.get(options.benchmark) ?? [];
  const calendar = benchmarkBars.map((bar) => bar.date);
  const indexes = new Map(options.symbols.map((symbol) => [symbol, indexByDate(bars.get(symbol) ?? [])]));
  const benchmarkIndex = indexByDate(benchmarkBars);
  const eligible = new Set<string>();
  const periods: ReplayPeriod[] = [];

  const firstDecision = calendar.findIndex((date) => date >= options.startDate);
  if (firstDecision === -1) return { periods, summary: summarize(periods, 0, options) };

  for (let i = firstDecision; i + options.hold < calendar.length; i += options.every) {
    const date = calendar[i] as string;
    if (date > options.endDate) break;
    const exitDate = calendar[i + options.hold] as string;
    const spyEntry = benchmarkBars[i] as DailyBar;
    const spyExit = benchmarkBars[i + options.hold] as DailyBar;
    const spyBefore = benchmarkBars.slice(0, benchmarkIndex.get(date) ?? i);

    const rows: { symbol: string; ruleScore: number; interest: number; forward: number }[] = [];
    for (const symbol of options.symbols) {
      const series = bars.get(symbol) ?? [];
      const index = indexes.get(symbol);
      const entryIndex = index?.get(date);
      const exitIndex = index?.get(exitDate);
      // Needs a bar on both the entry and exit sessions, and enough
      // history before entry. A missing bar means skip, never fill.
      if (entryIndex === undefined || exitIndex === undefined || entryIndex < MIN_HISTORY) continue;
      const features = computeFeatures(series.slice(0, entryIndex), spyBefore);
      const entry = series[entryIndex] as DailyBar;
      const exit = series[exitIndex] as DailyBar;
      rows.push({
        symbol,
        ruleScore: ruleScore(features),
        // History has no news or filings here, so this is the price part
        // of the screen only.
        interest: interestScore({ features, newNewsCount: 0, newFilingForms: [] }),
        forward: exit.open / entry.open - 1,
      });
      eligible.add(symbol);
    }
    if (rows.length < options.top * 2) continue;

    const byRule = [...rows].sort((a, b) => b.ruleScore - a.ruleScore || a.symbol.localeCompare(b.symbol));
    const picks = byRule.slice(0, options.top);
    const byInterest = [...rows].sort((a, b) => b.interest - a.interest || a.symbol.localeCompare(b.symbol));
    const screened = byInterest.slice(0, options.top);
    const rest = byInterest.slice(options.top);

    periods.push({
      date,
      exitDate,
      picks: picks.map(({ symbol, ruleScore: score, forward }) => ({ symbol, ruleScore: score, forward })),
      screened: screened.map((row) => row.symbol),
      benchmarkForward: spyExit.open / spyEntry.open - 1,
      universeForward: mean(rows.map((row) => row.forward)),
      picksForward: mean(picks.map((row) => row.forward)) - options.costBps / 10_000,
      screenedAbsMove: mean(screened.map((row) => Math.abs(row.forward))),
      restAbsMove: mean(rest.map((row) => Math.abs(row.forward))),
    });
  }
  return { periods, summary: summarize(periods, eligible.size, options) };
}

function summarize(periods: ReplayPeriod[], eligibleSymbols: number, options: ReplayOptions): ReplaySummary {
  // Compounding overlapping holds would double count, so growth uses
  // every period only when decisions are at least `hold` apart.
  const step = Math.max(1, Math.ceil(options.hold / options.every));
  let picksGrowth = 1;
  let benchmarkGrowth = 1;
  for (let i = 0; i < periods.length; i += step) {
    const period = periods[i] as ReplayPeriod;
    picksGrowth *= 1 + period.picksForward;
    benchmarkGrowth *= 1 + period.benchmarkForward;
  }
  const rest = mean(periods.map((period) => period.restAbsMove));
  return {
    periods: periods.length,
    eligibleSymbols,
    picksVsBenchmark: mean(periods.map((period) => period.picksForward - period.benchmarkForward)),
    picksVsUniverse: mean(periods.map((period) => period.picksForward - period.universeForward)),
    hitRate: periods.length === 0 ? 0 : periods.filter((period) => period.picksForward > period.benchmarkForward).length / periods.length,
    picksGrowth: picksGrowth - 1,
    benchmarkGrowth: benchmarkGrowth - 1,
    screenLift: rest > 0 ? mean(periods.map((period) => period.screenedAbsMove)) / rest : 0,
  };
}

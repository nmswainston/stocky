import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DailyBar, Thesis } from '../types.js';

// Grades theses that were written before their outcome existed: the
// daily digests, and --as-of runs (marked, since an as-of thesis about
// the past can lean on the model's memory of what happened next).
//
// Entry is the first session open strictly after the thesis was written
// (a thesis written at 5:30 AM Phoenix enters at that morning's open),
// exit is the open `horizon` sessions later, compared with SPY over the
// same sessions.

export interface SavedThesis {
  thesis: Thesis;
  asOf: string;
  asOfRun: boolean;
}

export interface GradedThesis {
  symbol: string;
  asOf: string;
  asOfRun: boolean;
  score: number;
  confidence: Thesis['confidence'];
  horizon: number;
  excess: number; // stock return minus SPY return
}

export interface ScoreBucket {
  label: string;
  count: number;
  meanExcess: number;
  hitRate: number; // share that beat SPY
}

export async function loadSavedTheses(researchDirectory: string): Promise<SavedThesis[]> {
  const found: SavedThesis[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('theses.json') && names.has('run.json')) {
      const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')) as { asOf: string; asOfRun?: boolean; dryRun?: boolean };
      if (!run.dryRun) {
        const theses = JSON.parse(await readFile(path.join(directory, 'theses.json'), 'utf8')) as Thesis[];
        for (const thesis of theses) found.push({ thesis, asOf: run.asOf, asOfRun: run.asOfRun === true });
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'cache' && entry.name !== 'prompts') {
        await walk(path.join(directory, entry.name));
      }
    }
  }
  await walk(researchDirectory);
  return found;
}

function forward(bars: DailyBar[], asOf: string, horizon: number): number | null {
  // Bars are dated by session; a thesis written on a session's date
  // before the open enters at that open.
  const asOfDate = asOf.slice(0, 10);
  const entryIndex = bars.findIndex((bar) => bar.date >= asOfDate);
  if (entryIndex === -1 || entryIndex + horizon >= bars.length) return null;
  return (bars[entryIndex + horizon] as DailyBar).open / (bars[entryIndex] as DailyBar).open - 1;
}

export function gradeTheses(
  saved: SavedThesis[],
  bars: Map<string, DailyBar[]>,
  benchmark: string,
  horizon: number,
): GradedThesis[] {
  const benchmarkBars = bars.get(benchmark) ?? [];
  const graded: GradedThesis[] = [];
  for (const item of saved) {
    const stock = forward(bars.get(item.thesis.symbol) ?? [], item.asOf, horizon);
    const spy = forward(benchmarkBars, item.asOf, horizon);
    if (stock === null || spy === null) continue; // too recent to grade
    graded.push({
      symbol: item.thesis.symbol,
      asOf: item.asOf,
      asOfRun: item.asOfRun,
      score: item.thesis.score,
      confidence: item.thesis.confidence,
      horizon,
      excess: stock - spy,
    });
  }
  return graded;
}

// The research page's track record panel: every live thesis graded at
// several horizons, bucketed by score. As-of replays are excluded here,
// whatever the CLI report shows, because a thesis written about the
// past can lean on the model's memory of what happened next.

export interface HorizonSummary {
  horizon: number;
  graded: number;
  // Too recent for the horizon, or missing bars.
  ungraded: number;
  buckets: ScoreBucket[];
}

export interface ScorecardSummary {
  generatedAt: string;
  benchmark: string;
  liveTheses: number;
  asOfExcluded: number;
  horizons: HorizonSummary[];
}

export function scorecardSummary(
  saved: SavedThesis[],
  bars: Map<string, DailyBar[]>,
  benchmark: string,
  horizons: number[],
  generatedAt: string,
): ScorecardSummary {
  const live = saved.filter((item) => !item.asOfRun);
  return {
    generatedAt,
    benchmark,
    liveTheses: live.length,
    asOfExcluded: saved.length - live.length,
    horizons: horizons.map((horizon) => {
      const graded = gradeTheses(live, bars, benchmark, horizon);
      return { horizon, graded: graded.length, ungraded: live.length - graded.length, buckets: bucketize(graded) };
    }),
  };
}

export function bucketize(graded: GradedThesis[]): ScoreBucket[] {
  const buckets: { label: string; test: (score: number) => boolean }[] = [
    { label: 'Positive (+2 to +5)', test: (score) => score >= 2 },
    { label: 'Neutral (-1 to +1)', test: (score) => score > -2 && score < 2 },
    { label: 'Negative (-5 to -2)', test: (score) => score <= -2 },
  ];
  return buckets.map(({ label, test }) => {
    const rows = graded.filter((row) => test(row.score));
    return {
      label,
      count: rows.length,
      meanExcess: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.excess, 0) / rows.length,
      hitRate: rows.length === 0 ? 0 : rows.filter((row) => row.excess > 0).length / rows.length,
    };
  });
}

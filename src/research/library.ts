import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WatchRow } from './run.js';
import type { Snapshot, SourceKind, SourceRef, Thesis } from './types.js';

// Read side of the research output for the dashboard's research page.
// Joins one day's theses.json, run.json and snapshots.json into a shape
// the page can render without knowing how the pipeline stores things.
// Reads only.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ResearchDaySummary {
  date: string;
  dryRun: boolean;
  thesisCount: number;
  costUsd: number | null;
  model: string | null;
}

export interface Citation {
  n: number; // footnote number within its thesis, in order of first use
  kind: SourceKind;
  label: string;
  url: string | null;
}

export interface CitedPoint {
  point: string;
  cites: number[];
}

export interface ThesisView {
  symbol: string;
  companyName: string | null;
  score: number;
  confidence: Thesis['confidence'];
  summary: string;
  bull: CitedPoint[];
  bear: CitedPoint[];
  watchFor: string[];
  verified: boolean;
  problems: string[];
  lastClose: number | null;
  lastDate: string | null;
  return20d: number | null;
  vsBenchmark20d: number | null;
  sources: Citation[];
}

export interface WatchView {
  symbol: string;
  companyName: string | null;
  lastClose: number | null;
  return5d: number | null;
  return20d: number | null;
  vsBenchmark20d: number | null;
  interest: number;
  researched: boolean;
  dataProblems: string[];
}

export interface ResearchDay {
  date: string;
  asOf: string | null;
  model: string | null;
  dryRun: boolean;
  costUsd: number | null;
  budgetUsd: number | null;
  theses: ThesisView[];
  watchlist: WatchView[];
  skipped: { symbol: string; reason: string }[];
}

interface RunFile {
  asOf?: string;
  model?: string;
  dryRun?: boolean;
  costUsd?: number;
  budgetUsd?: number;
  skipped?: { symbol: string; reason: string }[];
  watchlist?: WatchRow[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// Links come from news feeds and SEC; only plain web links get through.
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function thesisView(thesis: Thesis, snapshot: Snapshot | undefined): ThesisView {
  const known = new Map<string, SourceRef>((snapshot?.sources ?? []).map((source) => [source.id, source]));
  const sources: Citation[] = [];
  const numberOf = new Map<string, number>();
  const cite = (ids: string[]): number[] =>
    ids.map((id) => {
      let n = numberOf.get(id);
      if (n === undefined) {
        const source = known.get(id);
        n = sources.length + 1;
        numberOf.set(id, n);
        sources.push({
          n,
          kind: source?.kind ?? 'news',
          label: source?.label ?? id,
          url: safeUrl(source?.url),
        });
      }
      return n;
    });
  const features = snapshot?.features ?? null;
  return {
    symbol: thesis.symbol,
    companyName: snapshot?.companyName ?? null,
    score: thesis.score,
    confidence: thesis.confidence,
    summary: thesis.summary,
    bull: thesis.bull.map((item) => ({ point: item.point, cites: cite(item.sources) })),
    bear: thesis.bear.map((item) => ({ point: item.point, cites: cite(item.sources) })),
    watchFor: thesis.watchFor,
    verified: thesis.verified,
    problems: thesis.problems,
    lastClose: features?.lastClose ?? null,
    lastDate: features?.lastDate ?? null,
    return20d: features?.return20d ?? null,
    vsBenchmark20d: features?.vsBenchmark20d ?? null,
    sources,
  };
}

function watchView(row: WatchRow): WatchView {
  return {
    symbol: row.symbol,
    companyName: row.companyName,
    lastClose: row.features?.lastClose ?? null,
    return5d: row.features?.return5d ?? null,
    return20d: row.features?.return20d ?? null,
    vsBenchmark20d: row.features?.vsBenchmark20d ?? null,
    interest: row.interest,
    researched: row.researched,
    dataProblems: row.dataProblems,
  };
}

export function isResearchDate(value: string): boolean {
  return DATE.test(value);
}

/** Days with a saved run, newest first. Folders that are not dates are ignored. */
export async function listResearchDays(directory: string): Promise<ResearchDaySummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const days: ResearchDaySummary[] = [];
  for (const date of names.filter(isResearchDate).sort().reverse()) {
    const run = await readJson<RunFile>(path.join(directory, date, 'run.json'));
    if (!run) continue;
    const theses = (await readJson<Thesis[]>(path.join(directory, date, 'theses.json'))) ?? [];
    days.push({
      date,
      dryRun: run.dryRun === true,
      thesisCount: theses.length,
      costUsd: run.costUsd ?? null,
      model: run.model ?? null,
    });
  }
  return days;
}

/** One day's research, joined and ready to render; null when there is none. */
export async function readResearchDay(directory: string, date: string): Promise<ResearchDay | null> {
  if (!isResearchDate(date)) return null;
  const folder = path.join(directory, date);
  const run = await readJson<RunFile>(path.join(folder, 'run.json'));
  if (!run) return null;
  const theses = (await readJson<Thesis[]>(path.join(folder, 'theses.json'))) ?? [];
  const snapshots = (await readJson<Snapshot[]>(path.join(folder, 'snapshots.json'))) ?? [];
  const bySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  return {
    date,
    asOf: run.asOf ?? null,
    model: run.model ?? null,
    dryRun: run.dryRun === true,
    costUsd: run.costUsd ?? null,
    budgetUsd: run.budgetUsd ?? null,
    theses: theses
      .map((thesis) => thesisView(thesis, bySymbol.get(thesis.symbol)))
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)),
    watchlist: (run.watchlist ?? []).map(watchView),
    skipped: run.skipped ?? [],
  };
}

// Shapes shared across the research pipeline. Money and prices are
// plain numbers here: this is research display, not the fill model,
// which keeps its exact decimal strings.

export interface DailyBar {
  date: string; // YYYY-MM-DD, the session date
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  createdAt: string; // ISO
  url: string;
  symbols: string[];
}

export interface Filing {
  accession: string;
  form: string;
  filedOn: string; // YYYY-MM-DD
  reportDate: string | null;
  url: string;
}

export interface QuarterFact {
  concept: string; // our label: revenue, netIncome, epsDiluted
  periodEnd: string;
  value: number;
  form: string;
  filedOn: string;
}

export interface Features {
  lastClose: number;
  lastDate: string;
  return5d: number | null;
  return20d: number | null;
  return60d: number | null;
  vsBenchmark20d: number | null; // return20d minus the benchmark's
  volatility20d: number | null; // daily stdev of returns, as a fraction
  distanceFromSma50: number | null; // fraction above (+) or below (-)
  volumeRatio20d: number | null; // last volume / 20 day average
  belowWindowHigh: number | null; // fraction below the highest high in the bar window (about 4 months)
}

export type SourceKind = 'price' | 'news' | 'filing' | 'fact';

export interface SourceRef {
  id: string;
  kind: SourceKind;
  label: string;
  url?: string;
}

export interface Snapshot {
  symbol: string;
  companyName: string | null;
  asOf: string; // ISO; nothing newer than this is included
  features: Features | null;
  recentCloses: { date: string; close: number }[];
  news: NewsItem[];
  filings: Filing[];
  facts: QuarterFact[];
  sources: SourceRef[];
  dataProblems: string[];
}

export interface ThesisPoint {
  point: string;
  sources: string[];
}

export interface Thesis {
  symbol: string;
  score: number; // -5 (strong avoid) .. +5 (strong buy candidate)
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  bull: ThesisPoint[];
  bear: ThesisPoint[];
  watchFor: string[];
  verified: boolean;
  problems: string[];
}

// The model's own most recent live thesis on a symbol, fed back into
// the next prompt for continuity. Carries no sources on purpose: it is
// context, not citable evidence.
export interface PriorThesis {
  asOf: string; // ISO, when it was written
  score: number;
  confidence: Thesis['confidence'];
  summary: string;
  watchFor: string[];
}

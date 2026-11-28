import type { DailyBar, PriorThesis, Snapshot } from './types.js';

// The instructions stay identical for every stock and every day, so the
// only thing that changes between calls is the snapshot.

export const SYSTEM_PROMPT = `You are the research analyst for a personal, long-only stock research tool. Each request gives you a snapshot of one US stock: price features, the last ten closes, recent news headlines and summaries, recent SEC filings, and quarterly figures from XBRL filings. Every item in the snapshot has a source id.

Write a short, honest thesis on whether this stock is a good candidate to own over the next one to three months, judged only from the snapshot.

Rules:
- Use only facts that appear in the snapshot. Do not add numbers, events, guidance, analyst views or prices from your own memory, because your memory may be out of date or describe a different period than the snapshot.
- Every bull and bear point must cite at least one source id from the snapshot, copied exactly. A point you cannot cite does not belong in the thesis.
- Score from -5 to +5. Positive means a better candidate to own, negative means one to avoid. Most stocks on most days are between -2 and +2. Use +4 or +5, or -4 or -5, only when several independent cited facts point the same way.
- Confidence is about the evidence, not the story. Use low when the snapshot is thin, stale, mostly headlines, or the facts conflict. Use high only with fresh, specific, consistent evidence from more than one kind of source.
- A big price move alone is not a thesis. Explain what caused it if the snapshot shows that, and say so plainly if it does not.
- A prior_thesis block, when present, is your own most recent thesis on this stock and how the stock has done against SPY since. Use it for continuity: when your view changes, say in the summary what changed since then. It is context, not evidence: it has no source id, and no point may cite it.
- Write for a reader on a phone: the summary is two or three plain sentences, and each point is one sentence.
- watch_for lists one to three things that would change your view.

This output feeds research notes only. It does not place trades.`;

function pct(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(2)}%`;
}

export interface PriorPromptView {
  written: string;
  score: number;
  confidence: string;
  summary: string;
  watch_for: string[];
  stock_return_since: string | null;
  vs_benchmark_since: string | null;
}

// Entry at the first session's open on or after the prior thesis date,
// exit at the latest close: the same entry convention the scorecard
// grades with. Null when the window does not cover the prior date.
function returnSince(bars: DailyBar[], sinceDate: string): number | null {
  const entry = bars.find((bar) => bar.date >= sinceDate);
  const last = bars[bars.length - 1];
  if (!entry || !last || entry.date >= last.date) return null;
  return last.close / entry.open - 1;
}

export function priorForPrompt(prior: PriorThesis, bars: DailyBar[], benchmarkBars: DailyBar[]): PriorPromptView {
  const sinceDate = prior.asOf.slice(0, 10);
  const stock = returnSince(bars, sinceDate);
  const benchmark = returnSince(benchmarkBars, sinceDate);
  return {
    written: sinceDate,
    score: prior.score,
    confidence: prior.confidence,
    summary: prior.summary,
    watch_for: prior.watchFor,
    stock_return_since: pct(stock),
    vs_benchmark_since: stock !== null && benchmark !== null ? pct(stock - benchmark) : null,
  };
}

export function snapshotForPrompt(snapshot: Snapshot, prior: PriorPromptView | null = null): string {
  const f = snapshot.features;
  const view = {
    symbol: snapshot.symbol,
    company: snapshot.companyName,
    as_of: snapshot.asOf,
    price: f
      ? {
          source_id: `price:${snapshot.symbol}`,
          last_close: f.lastClose,
          last_session: f.lastDate,
          return_5d: pct(f.return5d),
          return_20d: pct(f.return20d),
          return_60d: pct(f.return60d),
          return_20d_vs_spy: pct(f.vsBenchmark20d),
          daily_volatility_20d: pct(f.volatility20d),
          distance_from_50d_average: pct(f.distanceFromSma50),
          below_4_month_high: pct(f.belowWindowHigh),
          volume_vs_20d_average: f.volumeRatio20d === null ? null : `${f.volumeRatio20d.toFixed(2)}x`,
          recent_closes: snapshot.recentCloses,
        }
      : null,
    news: snapshot.news.map((item) => ({
      source_id: `news:${item.id}`,
      published: item.createdAt,
      outlet: item.source,
      headline: item.headline,
      summary: item.summary || null,
    })),
    filings: snapshot.filings.map((filing) => ({
      source_id: `filing:${filing.accession}`,
      form: filing.form,
      filed: filing.filedOn,
      period: filing.reportDate,
    })),
    quarterly_figures: snapshot.facts.map((fact) => ({
      source_id: `fact:${fact.concept}:${fact.periodEnd}`,
      metric: fact.concept,
      quarter_end: fact.periodEnd,
      value: fact.value,
      filed: fact.filedOn,
    })),
    ...(prior ? { prior_thesis: prior } : {}),
    data_problems: snapshot.dataProblems,
  };
  return `Snapshot:\n${JSON.stringify(view, null, 2)}\n\nWrite the thesis for ${snapshot.symbol}.`;
}

const point = {
  type: 'object',
  properties: {
    point: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['point', 'sources'],
  additionalProperties: false,
} as const;

// Structured output schema: the API guarantees JSON in this shape;
// thesis.ts still re-checks everything, because a valid shape can hold
// invalid content (a made-up source id, for one).
export const THESIS_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', enum: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    bull: { type: 'array', items: point },
    bear: { type: 'array', items: point },
    watch_for: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'confidence', 'summary', 'bull', 'bear', 'watch_for'],
  additionalProperties: false,
} as const;

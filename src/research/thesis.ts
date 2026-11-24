import type { Snapshot, Thesis, ThesisPoint } from './types.js';

// Turns the model's JSON into a Thesis the rest of the app can trust.
// The rule: code checks, the model suggests. Problems are recorded on
// the thesis and shown in the digest rather than hidden.

const SCORES = new Set([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
const CONFIDENCE = new Set(['low', 'medium', 'high']);

function asPoints(value: unknown, known: Set<string>, side: string, problems: string[]): ThesisPoint[] {
  if (!Array.isArray(value)) {
    problems.push(`${side} was not a list`);
    return [];
  }
  const kept: ThesisPoint[] = [];
  for (const raw of value) {
    const text = typeof raw?.point === 'string' ? raw.point.trim() : '';
    const cited = Array.isArray(raw?.sources) ? raw.sources.filter((id: unknown) => typeof id === 'string') : [];
    const valid = cited.filter((id: string) => known.has(id));
    const invented = cited.filter((id: string) => !known.has(id));
    if (invented.length > 0) problems.push(`${side} cited unknown source ${invented.join(', ')}`);
    if (text === '') continue;
    if (valid.length === 0) {
      problems.push(`dropped an uncited ${side} point`);
      continue;
    }
    kept.push({ point: text, sources: valid });
  }
  return kept;
}

export function validateThesis(raw: unknown, snapshot: Snapshot): Thesis {
  const problems: string[] = [];
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const known = new Set(snapshot.sources.map((source) => source.id));

  let score = typeof data.score === 'number' ? Math.round(data.score) : 0;
  if (!SCORES.has(score)) {
    problems.push(`score ${String(data.score)} out of range, set to 0`);
    score = 0;
  }
  let confidence = String(data.confidence) as Thesis['confidence'];
  if (!CONFIDENCE.has(confidence)) {
    problems.push(`confidence ${String(data.confidence)} not recognized, set to low`);
    confidence = 'low';
  }
  const bull = asPoints(data.bull, known, 'bull', problems);
  const bear = asPoints(data.bear, known, 'bear', problems);

  // A strong score has to be earned by cited points on that side.
  const support = score > 0 ? bull.length : score < 0 ? bear.length : 1;
  if (Math.abs(score) >= 2 && support === 0) {
    problems.push(`score ${score} had no cited support, set to 0`);
    score = 0;
  }
  // Thin or broken input caps confidence, whatever the model said.
  if (snapshot.dataProblems.length > 0 && confidence === 'high') {
    problems.push('confidence lowered to medium because the snapshot had data problems');
    confidence = 'medium';
  }

  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  if (summary === '') problems.push('empty summary');
  const watchFor = Array.isArray(data.watch_for)
    ? data.watch_for.filter((item): item is string => typeof item === 'string').slice(0, 3)
    : [];

  return {
    symbol: snapshot.symbol,
    score,
    confidence,
    summary,
    bull,
    bear,
    watchFor,
    verified: problems.length === 0,
    problems,
  };
}

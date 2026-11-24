import type { DailyBar, Features } from './types.js';

// Plain price math the screen and the prompt share. Pure: same bars in,
// same numbers out, no clock and no network.

function returnOver(bars: DailyBar[], sessions: number): number | null {
  if (bars.length <= sessions) return null;
  const last = bars[bars.length - 1] as DailyBar;
  const base = bars[bars.length - 1 - sessions] as DailyBar;
  return last.close / base.close - 1;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeFeatures(bars: DailyBar[], benchmark: DailyBar[] = []): Features | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1] as DailyBar;

  const return20d = returnOver(bars, 20);
  const benchmark20d = returnOver(benchmark, 20);

  let volatility20d: number | null = null;
  if (bars.length > 20) {
    const daily: number[] = [];
    for (let i = bars.length - 20; i < bars.length; i += 1) {
      daily.push((bars[i] as DailyBar).close / (bars[i - 1] as DailyBar).close - 1);
    }
    const average = mean(daily);
    volatility20d = Math.sqrt(mean(daily.map((value) => (value - average) ** 2)));
  }

  let distanceFromSma50: number | null = null;
  if (bars.length >= 50) {
    const sma = mean(bars.slice(-50).map((bar) => bar.close));
    distanceFromSma50 = last.close / sma - 1;
  }

  let volumeRatio20d: number | null = null;
  if (bars.length > 20) {
    const prior = bars.slice(-21, -1).map((bar) => bar.volume);
    const average = mean(prior);
    volumeRatio20d = average > 0 ? last.volume / average : null;
  }

  const high = Math.max(...bars.map((bar) => bar.high));

  return {
    lastClose: last.close,
    lastDate: last.date,
    return5d: returnOver(bars, 5),
    return20d,
    return60d: returnOver(bars, 60),
    vsBenchmark20d: return20d !== null && benchmark20d !== null ? return20d - benchmark20d : null,
    volatility20d,
    distanceFromSma50,
    volumeRatio20d,
    belowWindowHigh: high > 0 ? last.close / high - 1 : null,
  };
}

// How unusual today looks, so the daily budget goes to the names where
// something happened. Not a buy signal: a big drop scores as high as a
// big rise. Deterministic and cheap; the expensive judgment is Claude's.
export function interestScore(input: {
  features: Features | null;
  newNewsCount: number;
  newFilingForms: string[];
}): number {
  let score = 0;
  const f = input.features;
  if (f && f.return5d !== null && f.volatility20d !== null && f.volatility20d > 0) {
    // A 5 day move measured in "normal days" of noise (sqrt(5) scaling).
    score += Math.min(Math.abs(f.return5d) / (f.volatility20d * Math.sqrt(5)), 4);
  }
  if (f && f.volumeRatio20d !== null && f.volumeRatio20d > 1.5) {
    score += Math.min(f.volumeRatio20d - 1, 3);
  }
  score += Math.min(input.newNewsCount, 10) * 0.2;
  if (input.newFilingForms.some((form) => form.startsWith('10-'))) score += 3;
  if (input.newFilingForms.includes('8-K')) score += 1.5;
  return Math.round(score * 100) / 100;
}

export function pickForResearch(
  scores: { symbol: string; score: number; mustResearch: boolean }[],
  count: number,
): string[] {
  const forced = scores.filter((row) => row.mustResearch).map((row) => row.symbol);
  const ranked = scores
    .filter((row) => !row.mustResearch)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .map((row) => row.symbol);
  return [...forced, ...ranked].slice(0, Math.max(count, 0));
}

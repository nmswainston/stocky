import { describe, expect, it } from 'vitest';
import type { DailyBar, Thesis } from '../types.js';
import { scorecardSummary, type SavedThesis } from './scorecard.js';

// Ten sessions starting 2026-01-02, with a per-session open step so
// forward returns are exact and easy to reason about.
function sessions(startOpen: number, step: number): DailyBar[] {
  return Array.from({ length: 10 }, (_, index) => {
    const open = startOpen + step * index;
    const date = `2026-01-${String(2 + index).padStart(2, '0')}`;
    return { date, open, high: open, low: open, close: open, volume: 1000 };
  });
}

function thesis(symbol: string, score: number): Thesis {
  return {
    symbol,
    score,
    confidence: 'medium',
    summary: 'test',
    bull: [],
    bear: [],
    watchFor: [],
    verified: true,
    problems: [],
  };
}

function saved(symbol: string, score: number, asOfRun = false): SavedThesis {
  return { thesis: thesis(symbol, score), asOf: '2026-01-02T12:30:00.000Z', asOfRun };
}

describe('scorecardSummary', () => {
  const bars = new Map<string, DailyBar[]>([
    ['UP', sessions(100, 10)], // strong riser
    ['SPY', sessions(100, 1)], // mild riser
  ]);

  it('grades live theses per horizon and buckets them by score', () => {
    const summary = scorecardSummary([saved('UP', 3)], bars, 'SPY', [5, 20], '2026-02-01T00:00:00.000Z');
    expect(summary.liveTheses).toBe(1);
    expect(summary.asOfExcluded).toBe(0);
    expect(summary.horizons).toHaveLength(2);

    const h5 = summary.horizons[0];
    expect(h5?.horizon).toBe(5);
    expect(h5?.graded).toBe(1);
    expect(h5?.ungraded).toBe(0);
    const positive = h5?.buckets.find((bucket) => bucket.label.startsWith('Positive'));
    expect(positive?.count).toBe(1);
    expect(positive?.hitRate).toBe(1);
    // UP: 150/100 - 1 = 0.5; SPY: 105/100 - 1 = 0.05; excess 0.45.
    expect(positive?.meanExcess).toBeCloseTo(0.45, 10);

    // Ten sessions of bars cannot grade a 20 session horizon.
    const h20 = summary.horizons[1];
    expect(h20?.graded).toBe(0);
    expect(h20?.ungraded).toBe(1);
  });

  it('excludes as-of replays from the panel entirely', () => {
    const summary = scorecardSummary(
      [saved('UP', 3), saved('UP', 5, true)],
      bars,
      'SPY',
      [5],
      '2026-02-01T00:00:00.000Z',
    );
    expect(summary.liveTheses).toBe(1);
    expect(summary.asOfExcluded).toBe(1);
    expect(summary.horizons[0]?.graded).toBe(1);
  });
});

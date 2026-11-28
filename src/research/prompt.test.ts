import { describe, expect, it } from 'vitest';
import { priorForPrompt } from './prompt.js';
import { dailyBars } from './testing/fixtures.js';
import type { PriorThesis } from './types.js';

const prior: PriorThesis = {
  asOf: '2026-06-03T12:30:00.000Z',
  score: 3,
  confidence: 'medium',
  summary: 'Prior view.',
  watchFor: ['earnings'],
};

describe('priorForPrompt', () => {
  it('computes performance since the prior thesis, entry at next open', () => {
    // Stock closes 100..104 from 2026-06-01; SPY flat at 100.
    const bars = dailyBars([100, 101, 102, 103, 104]);
    const spy = dailyBars([100, 100, 100, 100, 100]);
    const view = priorForPrompt(prior, bars, spy);
    expect(view.written).toBe('2026-06-03');
    expect(view.score).toBe(3);
    expect(view.summary).toBe('Prior view.');
    // Entry at 2026-06-03's open (101), exit at the last close (104).
    expect(view.stock_return_since).toBe('2.97%');
    expect(view.vs_benchmark_since).toBe('2.97%');
  });

  it('reports null performance when the bar window misses the prior date', () => {
    const bars = dailyBars([100, 101], '2026-01-01');
    const view = priorForPrompt(prior, bars, bars);
    expect(view.stock_return_since).toBeNull();
    expect(view.vs_benchmark_since).toBeNull();
  });

  it('reports null performance when the window starts after the prior date', () => {
    // A prior older than the fetched history: entering at the window's
    // first bar would mislabel a partial return as the full one.
    const bars = dailyBars([100, 101, 102], '2026-06-10');
    const view = priorForPrompt(prior, bars, bars);
    expect(view.stock_return_since).toBeNull();
    expect(view.vs_benchmark_since).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { dailyBars, newsItem, rampCloses } from './testing/fixtures.js';
import { validateThesis } from './thesis.js';

const snapshot = buildSnapshot({
  symbol: 'TEST',
  companyName: 'Test Corp',
  asOf: '2026-09-01T12:00:00.000Z',
  bars: dailyBars(rampCloses(70)),
  benchmarkBars: [],
  news: [newsItem('1', '2026-08-30T10:00:00Z')],
  filings: [],
  facts: [],
});

describe('validateThesis', () => {
  it('keeps a well formed, fully cited thesis as verified', () => {
    const thesis = validateThesis(
      {
        score: 2,
        confidence: 'medium',
        summary: 'Steady climb.',
        bull: [{ point: 'Up 20 days running.', sources: ['price:TEST'] }],
        bear: [{ point: 'One headline only.', sources: ['news:1'] }],
        watch_for: ['next earnings'],
      },
      snapshot,
    );
    expect(thesis.verified).toBe(true);
    expect(thesis.score).toBe(2);
    expect(thesis.problems).toEqual([]);
  });

  it('drops points that cite sources the snapshot does not have', () => {
    const thesis = validateThesis(
      {
        score: 1,
        confidence: 'low',
        summary: 'x',
        bull: [
          { point: 'Made up fact.', sources: ['news:999'] },
          { point: 'Real fact.', sources: ['price:TEST', 'news:999'] },
        ],
        bear: [],
        watch_for: [],
      },
      snapshot,
    );
    expect(thesis.bull).toEqual([{ point: 'Real fact.', sources: ['price:TEST'] }]);
    expect(thesis.verified).toBe(false);
    expect(thesis.problems.join(' ')).toContain('news:999');
  });

  it('zeroes a strong score with no surviving support', () => {
    const thesis = validateThesis(
      {
        score: 5,
        confidence: 'high',
        summary: 'To the moon.',
        bull: [{ point: 'Trust me.', sources: [] }],
        bear: [],
        watch_for: [],
      },
      snapshot,
    );
    expect(thesis.score).toBe(0);
    expect(thesis.verified).toBe(false);
  });

  it('turns garbage into a neutral, unverified thesis', () => {
    const thesis = validateThesis(null, snapshot);
    expect(thesis.score).toBe(0);
    expect(thesis.confidence).toBe('low');
    expect(thesis.verified).toBe(false);
  });

  it('caps confidence when the data was incomplete', () => {
    const thin = { ...snapshot, dataProblems: ['news unavailable'] };
    const thesis = validateThesis(
      {
        score: 1,
        confidence: 'high',
        summary: 'x',
        bull: [{ point: 'Up.', sources: ['price:TEST'] }],
        bear: [],
        watch_for: [],
      },
      thin,
    );
    expect(thesis.confidence).toBe('medium');
  });
});

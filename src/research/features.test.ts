import { describe, expect, it } from 'vitest';
import { computeFeatures, interestScore, pickForResearch } from './features.js';
import { dailyBars, rampCloses } from './testing/fixtures.js';

describe('computeFeatures', () => {
  it('returns null with no bars', () => {
    expect(computeFeatures([])).toBeNull();
  });

  it('computes returns over sessions, not calendar days', () => {
    const f = computeFeatures(dailyBars(rampCloses(61, 100, 1)));
    expect(f?.lastClose).toBe(160);
    expect(f?.return5d).toBeCloseTo(160 / 155 - 1, 10);
    expect(f?.return20d).toBeCloseTo(160 / 140 - 1, 10);
    expect(f?.return60d).toBeCloseTo(160 / 100 - 1, 10);
  });

  it('leaves windows it cannot fill as null instead of guessing', () => {
    const f = computeFeatures(dailyBars([100, 101, 102]));
    expect(f?.return5d).toBeNull();
    expect(f?.volatility20d).toBeNull();
    expect(f?.distanceFromSma50).toBeNull();
  });

  it('measures the 20 day return against the benchmark', () => {
    const stock = dailyBars(rampCloses(30, 100, 2));
    const benchmark = dailyBars(rampCloses(30, 100, 1));
    const f = computeFeatures(stock, benchmark);
    const stock20 = 158 / 118 - 1;
    const bench20 = 129 / 109 - 1;
    expect(f?.vsBenchmark20d).toBeCloseTo(stock20 - bench20, 10);
  });

  it('flags a volume spike', () => {
    const bars = dailyBars(rampCloses(25));
    const last = bars[bars.length - 1];
    if (last) last.volume = 3_000_000;
    expect(computeFeatures(bars)?.volumeRatio20d).toBeCloseTo(3, 10);
  });
});

describe('interestScore and pickForResearch', () => {
  it('ranks a fresh 10-Q above a quiet day', () => {
    const quiet = interestScore({ features: null, newNewsCount: 0, newFilingForms: [] });
    const filing = interestScore({ features: null, newNewsCount: 0, newFilingForms: ['10-Q'] });
    expect(quiet).toBe(0);
    expect(filing).toBeGreaterThan(quiet);
  });

  it('always includes forced picks, then the highest scores, up to the limit', () => {
    const picked = pickForResearch(
      [
        { symbol: 'AAA', score: 1, mustResearch: false },
        { symbol: 'BBB', score: 9, mustResearch: false },
        { symbol: 'CCC', score: 0, mustResearch: true },
        { symbol: 'DDD', score: 5, mustResearch: false },
      ],
      3,
    );
    expect(picked).toEqual(['CCC', 'BBB', 'DDD']);
  });
});

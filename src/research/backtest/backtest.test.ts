import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dailyBars, rampCloses } from '../testing/fixtures.js';
import type { Thesis } from '../types.js';
import { replay, ruleScore, type ReplayOptions } from './replay.js';
import { renderReplay, renderScorecard } from './report.js';
import { bucketize, gradeTheses, loadSavedTheses } from './scorecard.js';

// 200 sessions: UP climbs 1% a day, DOWN falls 0.5% a day, SPY drifts up.
const sessions = 200;
const up = dailyBars(Array.from({ length: sessions }, (_, i) => 100 * 1.01 ** i));
const down = dailyBars(Array.from({ length: sessions }, (_, i) => 100 * 0.995 ** i));
const spy = dailyBars(rampCloses(sessions, 400, 0.2));
const bars = new Map([
  ['UP', up],
  ['DOWN', down],
  ['SPY', spy],
]);

const options: ReplayOptions = {
  symbols: ['UP', 'DOWN'],
  benchmark: 'SPY',
  startDate: up[0]!.date,
  endDate: up[sessions - 1]!.date,
  every: 10,
  hold: 10,
  top: 1,
  costBps: 10,
};

describe('ruleScore', () => {
  it('is neutral with no data and capped at +/-5', () => {
    expect(ruleScore(null)).toBe(0);
    const hot = { vsBenchmark20d: 1, distanceFromSma50: 1 } as Parameters<typeof ruleScore>[0];
    expect(ruleScore(hot)).toBe(5);
  });
});

describe('replay', () => {
  const { periods, summary } = replay(bars, options);

  it('waits for 61 sessions of history before the first decision', () => {
    expect(periods[0]?.date).toBe(up[70]!.date);
  });

  it('enters at the decision session open and exits at the open hold sessions later', () => {
    const first = periods[0]!;
    expect(first.exitDate).toBe(up[80]!.date);
    expect(first.picks[0]?.symbol).toBe('UP');
    expect(first.picks[0]?.forward).toBeCloseTo(up[80]!.open / up[70]!.open - 1, 10);
    expect(first.picksForward).toBeCloseTo(first.picks[0]!.forward - 0.001, 10);
  });

  it('summarizes a trend that continues as a win, after costs', () => {
    expect(summary.periods).toBe(periods.length);
    expect(summary.hitRate).toBe(1);
    expect(summary.picksVsBenchmark).toBeGreaterThan(0);
    expect(summary.picksGrowth).toBeGreaterThan(summary.benchmarkGrowth);
  });

  it('never uses a bar from the decision day or later to score', () => {
    // Change every bar from day 70 on: the first decision's pick must not change.
    const tampered = new Map(bars);
    tampered.set('DOWN', [...down.slice(0, 70), ...dailyBars(Array.from({ length: sessions - 70 }, () => 1_000), down[70]!.date)]);
    const again = replay(tampered, options);
    expect(again.periods[0]?.picks[0]?.symbol).toBe('UP');
  });

  it('puts the caveats in the report', () => {
    const report = renderReplay(options, summary, periods);
    expect(report).toContain('Survivorship bias');
    expect(report).toContain('It does not test Claude');
  });
});

function thesis(symbol: string, score: number): Thesis {
  return { symbol, score, confidence: 'medium', summary: '', bull: [], bear: [], watchFor: [], verified: true, problems: [] };
}

describe('scorecard', () => {
  it('grades from the first open on or after the thesis date, against SPY', () => {
    const asOf = `${up[100]!.date}T12:30:00.000Z`;
    const graded = gradeTheses(
      [
        { thesis: thesis('UP', 3), asOf, asOfRun: false },
        { thesis: thesis('DOWN', -3), asOf, asOfRun: false },
      ],
      bars,
      'SPY',
      20,
    );
    const spyMove = spy[120]!.open / spy[100]!.open - 1;
    expect(graded[0]?.excess).toBeCloseTo(up[120]!.open / up[100]!.open - 1 - spyMove, 10);
    const buckets = bucketize(graded);
    expect(buckets[0]).toMatchObject({ count: 1, hitRate: 1 });
    expect(buckets[2]).toMatchObject({ count: 1, hitRate: 0 });
  });

  it('skips theses too recent to grade', () => {
    const asOf = `${up[sessions - 5]!.date}T12:30:00.000Z`;
    expect(gradeTheses([{ thesis: thesis('UP', 3), asOf, asOfRun: false }], bars, 'SPY', 20)).toEqual([]);
  });

  it('loads live and as-of runs but skips dry runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stocky-scorecard-'));
    const write = async (folder: string, run: object, theses: Thesis[]) => {
      await mkdir(path.join(root, folder), { recursive: true });
      await writeFile(path.join(root, folder, 'run.json'), JSON.stringify(run));
      await writeFile(path.join(root, folder, 'theses.json'), JSON.stringify(theses));
    };
    await write('2026-09-01', { asOf: '2026-09-01T12:30:00Z' }, [thesis('UP', 2)]);
    await write('as-of/2025-03-03', { asOf: '2025-03-03T12:30:00Z', asOfRun: true }, [thesis('DOWN', -2)]);
    await write('2026-09-02', { asOf: '2026-09-02T12:30:00Z', dryRun: true }, [thesis('UP', 5)]);
    const saved = await loadSavedTheses(root);
    expect(saved.map((item) => [item.thesis.symbol, item.asOfRun]).sort()).toEqual([
      ['DOWN', true],
      ['UP', false],
    ]);
  });

  it('says when it is too early to judge', () => {
    expect(renderScorecard(20, [], bucketize([]))).toContain('Too early to judge');
  });
});

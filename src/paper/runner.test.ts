import { describe, expect, it } from 'vitest';
import { basisPointCosts } from '../backtest/costs.js';
import { buyAndHold } from '../backtest/strategies/buy-and-hold.js';
import { barsFromCloses } from '../backtest/testing/fixtures.js';
import type { Strategy } from '../backtest/types.js';
import { createBarFolder } from './fold.js';
import { ingestBars, type SessionRuntime } from './runner.js';
import { createBook, deserializeBook, serializeBook } from './session.js';

const config = {
  symbol: 'TEST-USD',
  initialEquity: '10000',
  positionFraction: 1,
  takerFeeBps: 60,
  makerFeeBps: 40,
  slippageBps: 10,
};
const costs = basisPointCosts(config);
const fractionBps = 10_000n;

// Deliberately depth-sensitive: goes long only once the window holds 12
// bars. A runner that loses pre-restart history resets this count and
// diverges, which is exactly the bug this file exists to prevent.
const depthTrigger: Strategy<Record<string, never>> = {
  name: 'depth-trigger',
  warmupBars: 0,
  decide: (window) => ({ signal: window.length >= 12 ? 'long' : 'flat', state: {} }),
};

const closes = Array.from({ length: 20 }, (_, i) => (100 + i).toFixed(2));
const bars = barsFromCloses(closes);

function freshRuntime(): SessionRuntime {
  return {
    history: [],
    main: createBook(config.initialEquity),
    baseline: createBook(config.initialEquity),
    lastProcessedBar: null,
    gaps: [],
  };
}

describe('runner restart integrity', () => {
  it('a restart rebuilds history so depth-sensitive signals match a never-crashed run', () => {
    const uninterrupted = freshRuntime();
    ingestBars(uninterrupted, bars, depthTrigger, buyAndHold, costs, fractionBps);

    // Run to bar 8, "crash": persist books and cursor, lose the
    // in-memory history, resume with a full refetch like the runner does.
    const beforeCrash = freshRuntime();
    ingestBars(beforeCrash, bars.slice(0, 8), depthTrigger, buyAndHold, costs, fractionBps);
    const resumed: SessionRuntime = {
      history: [],
      main: deserializeBook(serializeBook(beforeCrash.main)),
      baseline: deserializeBook(serializeBook(beforeCrash.baseline)),
      lastProcessedBar: beforeCrash.lastProcessedBar,
      gaps: [...beforeCrash.gaps],
    };
    ingestBars(resumed, bars, depthTrigger, buyAndHold, costs, fractionBps);

    // The depth trigger fires at bar 12 and fills at bar 13's open; a
    // truncated history would have pushed that past the end of the data.
    expect(uninterrupted.main.fills.length).toBe(1);
    expect(serializeBook(resumed.main)).toEqual(serializeBook(uninterrupted.main));
    expect(serializeBook(resumed.baseline)).toEqual(serializeBook(uninterrupted.baseline));
    expect(resumed.history.length).toBe(bars.length);
    expect(resumed.lastProcessedBar).toBe(uninterrupted.lastProcessedBar);
  });

  it('overlapping fetches neither duplicate history nor double-process bars', () => {
    const runtime = freshRuntime();
    ingestBars(runtime, bars.slice(0, 10), depthTrigger, buyAndHold, costs, fractionBps);
    // Each poll refetches from the cursor bar inclusive; feed a heavy
    // overlap on purpose.
    ingestBars(runtime, bars.slice(5, 15), depthTrigger, buyAndHold, costs, fractionBps);
    ingestBars(runtime, bars.slice(14), depthTrigger, buyAndHold, costs, fractionBps);

    const times = runtime.history.map((bar) => bar.bucketStart);
    expect(new Set(times).size).toBe(times.length);
    expect(runtime.history.length).toBe(bars.length);
    expect(runtime.main.equityCurve.length).toBe(bars.length);

    const oneShot = freshRuntime();
    ingestBars(oneShot, bars, depthTrigger, buyAndHold, costs, fractionBps);
    expect(serializeBook(runtime.main)).toEqual(serializeBook(oneShot.main));
  });

  it('timeframe sessions rebuild folded history across a restart', () => {
    // 60 raw 1m bars fold into 20 three-minute buckets. The depth
    // trigger fires at bucket 12; the restart lands at raw bar 30
    // (bucket 10), before the trigger, which is exactly where a
    // folder initialized from the cursor loses the past and diverges.
    const raw = barsFromCloses(Array.from({ length: 60 }, (_, i) => (100 + i).toFixed(2)));
    const bucketMs = 3 * 60_000;

    const uninterrupted = freshRuntime();
    ingestBars(
      uninterrupted,
      createBarFolder(3, null).push(raw),
      depthTrigger,
      buyAndHold,
      costs,
      fractionBps,
      bucketMs,
    );
    expect(uninterrupted.history.length).toBe(20);
    expect(uninterrupted.main.fills.length).toBe(1);

    const beforeCrash = freshRuntime();
    ingestBars(
      beforeCrash,
      createBarFolder(3, null).push(raw.slice(0, 30)),
      depthTrigger,
      buyAndHold,
      costs,
      fractionBps,
      bucketMs,
    );
    const resumed: SessionRuntime = {
      history: [],
      main: deserializeBook(serializeBook(beforeCrash.main)),
      baseline: deserializeBook(serializeBook(beforeCrash.baseline)),
      lastProcessedBar: beforeCrash.lastProcessedBar,
      gaps: [...beforeCrash.gaps],
    };
    // Restart: fresh folder from null, full refetch, like runPaper does.
    ingestBars(
      resumed,
      createBarFolder(3, null).push(raw),
      depthTrigger,
      buyAndHold,
      costs,
      fractionBps,
      bucketMs,
    );

    expect(serializeBook(resumed.main)).toEqual(serializeBook(uninterrupted.main));
    expect(resumed.history.length).toBe(20);
    expect(resumed.lastProcessedBar).toBe(uninterrupted.lastProcessedBar);
  });

  it('records a data gap exactly once', () => {
    const runtime = freshRuntime();
    const gappy = [...bars.slice(0, 5), ...bars.slice(9)];
    ingestBars(runtime, gappy, depthTrigger, buyAndHold, costs, fractionBps);
    expect(runtime.gaps).toHaveLength(1);
    expect(runtime.gaps[0]!.missedBars).toBe(4);
    // Refeeding the same window does not re-record the gap.
    ingestBars(runtime, gappy, depthTrigger, buyAndHold, costs, fractionBps);
    expect(runtime.gaps).toHaveLength(1);
  });
});

import { basisPointCosts } from '../backtest/costs.js';
import type { CostModel } from '../backtest/fills.js';
import { loadBarsHttp } from '../backtest/load-bars-http.js';
import { buildStrategy } from '../backtest/strategy-factory.js';
import type { ClosedBar, Fill, Strategy } from '../backtest/types.js';
import { logger } from '../logger.js';
import { createBarFolder } from './fold.js';
import { deserializeBook, serializeBook, stepBook, type BookState } from './session.js';
import { saveStateFile, type PaperStateFile } from './state-file.js';

// The paper trader's only impure loop: poll the collector for new
// closed 1m bars, fold them into the session's timeframe, feed them
// through the pure session step, persist. On startup it replays every
// bar since the session began, which both rebuilds the strategy's full
// window and catches up on anything missed while down.

const log = logger.child({ module: 'paper-runner' });

export interface RunnerOptions {
  apiBase: string;
  directory: string;
  pollMs: number;
}

// The mutable shell around the pure session: full timeframe-bar history
// since the session started, both books, and the processing cursor.
export interface SessionRuntime {
  history: ClosedBar[];
  main: BookState<unknown>;
  baseline: BookState<unknown>;
  lastProcessedBar: string | null;
  gaps: Array<{ from: string; to: string; missedBars: number }>;
}

export interface IngestEvents {
  onFill?: (fill: Fill) => void;
  onGap?: (gap: { from: string; to: string; missedBars: number }) => void;
}

// Folds timeframe bars into the runtime. Two invariants matter here and
// both have burned us before:
// - Bars at or before lastProcessedBar are NOT re-stepped, but they ARE
//   appended to history: after a restart the strategy must see the same
//   full window it would have seen without the restart. Skipping them
//   entirely made warmup re-fire and truncated every lookback.
// - History is strictly increasing, so overlapping feeds cannot
//   duplicate entries.
export function ingestBars(
  runtime: SessionRuntime,
  bars: readonly ClosedBar[],
  strategy: Strategy<unknown>,
  baselineStrategy: Strategy<unknown>,
  costs: CostModel,
  fractionBps: bigint,
  bucketMs = 60_000,
  events: IngestEvents = {},
): number {
  let processed = 0;
  for (const bar of bars) {
    const newest = runtime.history[runtime.history.length - 1];
    if (!newest || bar.bucketStart > newest.bucketStart) {
      runtime.history.push(bar);
    }
    if (runtime.lastProcessedBar && bar.bucketStart <= runtime.lastProcessedBar) continue;
    if (runtime.lastProcessedBar) {
      const stepMs = Date.parse(bar.bucketStart) - Date.parse(runtime.lastProcessedBar);
      const missedBars = Math.round(stepMs / bucketMs) - 1;
      if (missedBars > 0) {
        const gap = { from: runtime.lastProcessedBar, to: bar.bucketStart, missedBars };
        runtime.gaps.push(gap);
        events.onGap?.(gap);
      }
    }
    const fillsBefore = runtime.main.fills.length;
    runtime.main = stepBook(runtime.main, strategy, runtime.history, costs, fractionBps);
    runtime.baseline = stepBook(runtime.baseline, baselineStrategy, runtime.history, costs, fractionBps);
    for (const fill of runtime.main.fills.slice(fillsBefore)) {
      events.onFill?.(fill);
    }
    runtime.lastProcessedBar = bar.bucketStart;
    processed += 1;
  }
  return processed;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPaper(state: PaperStateFile, options: RunnerOptions): Promise<void> {
  const { config } = state;
  const strategy = buildStrategy(config.strategy);
  const baselineStrategy = buildStrategy({ kind: 'buyhold' });
  const costs = basisPointCosts(config);
  const fractionBps = BigInt(Math.round(config.positionFraction * 10_000));
  const timeframe = config.timeframeMinutes ?? 1;
  const bucketMs = timeframe * 60_000;

  const runtime: SessionRuntime = {
    history: [],
    main: deserializeBook(state.main),
    baseline: deserializeBook(state.baseline),
    lastProcessedBar: state.lastProcessedBar,
    // Shared reference on purpose: gap pushes land in the state file.
    gaps: state.gaps,
  };
  // Raw 1m bars fold into timeframe bars; a bucket is only released
  // once its period is proven over, mirroring the backtester exactly.
  // Started from null, not lastProcessedBar: on restart it must re-emit
  // the session's entire past so ingestBars can rebuild the window.
  // Already-processed buckets are then skipped by the cursor, not lost.
  const folder = createBarFolder(timeframe, null);
  let lastRawBar: string | null = null;
  let stopping = false;

  const events: IngestEvents = {
    onFill: (fill) => log.info({ fill }, 'paper fill'),
    onGap: (gap) => log.warn(gap, 'bar gap'),
  };

  const ingestRaw = (rawBars: ClosedBar[]): number => {
    const newest = rawBars[rawBars.length - 1];
    if (newest) lastRawBar = newest.bucketStart;
    return ingestBars(
      runtime,
      folder.push(rawBars),
      strategy,
      baselineStrategy,
      costs,
      fractionBps,
      bucketMs,
      events,
    );
  };

  const persist = async (): Promise<void> => {
    state.main = serializeBook(runtime.main);
    state.baseline = serializeBook(runtime.baseline);
    state.lastProcessedBar = runtime.lastProcessedBar;
    state.updatedAt = new Date().toISOString();
    await saveStateFile(options.directory, state);
  };

  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  // Startup: load the full session history (paginated, no ceiling),
  // rebuild the window, catch up on everything missed, then poll.
  const initial = await loadBarsHttp(options.apiBase, config.symbol, config.startedAt);
  const caughtUp = ingestRaw(initial);
  if (caughtUp > 0) {
    log.info({ caughtUp, lastProcessedBar: runtime.lastProcessedBar }, 'caught up');
    await persist();
  } else if (runtime.history.length > 0) {
    log.info({ historyBars: runtime.history.length }, 'history rebuilt, nothing new to process');
  } else {
    log.info({ startedAt: config.startedAt }, 'no bars yet, waiting for the first close');
  }

  while (!stopping) {
    await sleep(options.pollMs);
    if (stopping) break;
    try {
      // Poll from the newest raw bar seen, not the newest processed
      // bucket: a bucket in progress means raw bars are always ahead.
      const since = lastRawBar ?? config.startedAt;
      const bars = await loadBarsHttp(options.apiBase, config.symbol, since);
      const processed = ingestRaw(bars);
      if (processed > 0) await persist();
    } catch (error) {
      // The collector being down is survivable: bars keep accumulating
      // in its storage and the next successful poll replays them.
      log.warn({ err: error instanceof Error ? error.message : error }, 'poll failed');
    }
  }

  await persist();
  const lastEquity =
    runtime.main.equityCurve[runtime.main.equityCurve.length - 1]?.equity ?? config.initialEquity;
  log.info({ id: config.id, equity: lastEquity, fills: runtime.main.fills.length }, 'paper session saved');
}

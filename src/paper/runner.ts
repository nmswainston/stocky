import { basisPointCosts } from '../backtest/costs.js';
import { loadBarsHttp } from '../backtest/load-bars-http.js';
import { buildStrategy } from '../backtest/strategy-factory.js';
import type { ClosedBar } from '../backtest/types.js';
import { logger } from '../logger.js';
import { deserializeBook, serializeBook, stepBook, type BookState } from './session.js';
import { saveStateFile, type PaperStateFile } from './state-file.js';

// The paper trader's only impure loop: poll the collector for new
// closed bars, fold them through the pure session step, persist. On
// startup it replays every bar that arrived while it was down, which
// the session tests prove is identical to having never stopped.

const log = logger.child({ module: 'paper-runner' });

export interface RunnerOptions {
  apiBase: string;
  directory: string;
  pollMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPaper(state: PaperStateFile, options: RunnerOptions): Promise<void> {
  const { config } = state;
  const strategy = buildStrategy(config.strategy);
  const baselineStrategy = buildStrategy({ kind: 'buyhold' });
  const costs = basisPointCosts(config);
  const fractionBps = BigInt(Math.round(config.positionFraction * 10_000));

  let main: BookState<unknown> = deserializeBook(state.main);
  let baseline: BookState<unknown> = deserializeBook(state.baseline);

  // Full session history, kept in memory and grown in place. The bar
  // window mechanism makes stale references safe, same as the engine.
  const history: ClosedBar[] = [];
  let stopping = false;

  const persist = async (): Promise<void> => {
    state.main = serializeBook(main);
    state.baseline = serializeBook(baseline);
    state.updatedAt = new Date().toISOString();
    await saveStateFile(options.directory, state);
  };

  const processNewBars = (bars: ClosedBar[]): number => {
    let processed = 0;
    for (const bar of bars) {
      if (state.lastProcessedBar && bar.bucketStart <= state.lastProcessedBar) continue;
      if (state.lastProcessedBar) {
        const stepMs = Date.parse(bar.bucketStart) - Date.parse(state.lastProcessedBar);
        const missedBars = Math.round(stepMs / 60_000) - 1;
        if (missedBars > 0) {
          state.gaps.push({ from: state.lastProcessedBar, to: bar.bucketStart, missedBars });
          log.warn({ from: state.lastProcessedBar, to: bar.bucketStart, missedBars }, 'bar gap');
        }
      }
      history.push(bar);
      const fillsBefore = main.fills.length;
      main = stepBook(main, strategy, history, costs, fractionBps);
      baseline = stepBook(baseline, baselineStrategy, history, costs, fractionBps);
      for (const fill of main.fills.slice(fillsBefore)) {
        log.info({ fill }, 'paper fill');
      }
      state.lastProcessedBar = bar.bucketStart;
      processed += 1;
    }
    return processed;
  };

  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  // Startup: load the full session history, catch up on everything
  // missed, then settle into the poll loop.
  const initial = await loadBarsHttp(options.apiBase, config.symbol, config.startedAt);
  const caughtUp = processNewBars(initial);
  if (caughtUp > 0) {
    log.info({ caughtUp, lastProcessedBar: state.lastProcessedBar }, 'caught up');
    await persist();
  } else {
    log.info({ startedAt: config.startedAt }, 'no bars yet, waiting for the first close');
  }

  while (!stopping) {
    await sleep(options.pollMs);
    if (stopping) break;
    try {
      const since = state.lastProcessedBar ?? config.startedAt;
      const bars = await loadBarsHttp(options.apiBase, config.symbol, since);
      const processed = processNewBars(bars);
      if (processed > 0) await persist();
    } catch (error) {
      // The collector being down is survivable: bars keep accumulating
      // in its storage and the next successful poll replays them.
      log.warn({ err: error instanceof Error ? error.message : error }, 'poll failed');
    }
  }

  await persist();
  const lastEquity = main.equityCurve[main.equityCurve.length - 1]?.equity ?? config.initialEquity;
  log.info({ id: config.id, equity: lastEquity, fills: main.fills.length }, 'paper session saved');
}

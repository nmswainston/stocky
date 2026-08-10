import path from 'node:path';
import { numberArg, parseArgs } from '../cli-args.js';
import { buildStrategy, type StrategySpec } from '../backtest/strategy-factory.js';
import { logger } from '../logger.js';
import { createBook, serializeBook } from './session.js';
import { loadStateFile, saveStateFile, type PaperStateFile } from './state-file.js';
import { runPaper } from './runner.js';

// npm run paper -- --strategy sma --fast 5 --slow 20 --symbol BTC-USD
// A session id maps to one state file; running the same id resumes it
// with its stored config, and flags only matter on first creation.

const args = parseArgs(process.argv.slice(2));
const directory = path.resolve('data', 'paper');

function strategySpec(): StrategySpec {
  const name = args.get('strategy') ?? 'buyhold';
  switch (name) {
    case 'buyhold':
      return { kind: 'buyhold' };
    case 'sma':
      return { kind: 'sma', fast: numberArg(args, 'fast', 20), slow: numberArg(args, 'slow', 50) };
    default:
      throw new Error(`unknown strategy ${name}, expected buyhold or sma`);
  }
}

const spec = strategySpec();
const strategyName = buildStrategy(spec).name;
const symbol = args.get('symbol') ?? 'BTC-USD';
const id =
  args.get('id') ?? `${strategyName}-${symbol}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');

let state = await loadStateFile(directory, id);
if (state) {
  logger.info(
    { id, strategy: state.config.strategyName, lastProcessedBar: state.lastProcessedBar },
    'resuming paper session, stored config wins over flags',
  );
} else {
  const initialEquity = args.get('equity') ?? '10000';
  state = {
    version: 1,
    config: {
      id,
      symbol,
      strategy: spec,
      strategyName,
      initialEquity,
      positionFraction: numberArg(args, 'fraction', 1),
      takerFeeBps: numberArg(args, 'taker-bps', 60),
      makerFeeBps: numberArg(args, 'maker-bps', 40),
      slippageBps: numberArg(args, 'slippage-bps', 5),
      startedAt: new Date().toISOString(),
    },
    lastProcessedBar: null,
    gaps: [],
    main: serializeBook(createBook(initialEquity)),
    baseline: serializeBook(createBook(initialEquity)),
    updatedAt: new Date().toISOString(),
  } satisfies PaperStateFile;
  await saveStateFile(directory, state);
  logger.info({ id, strategy: strategyName, symbol }, 'created paper session');
}

await runPaper(state, {
  apiBase: args.get('api') ?? 'http://127.0.0.1:8787',
  directory,
  pollMs: numberArg(args, 'poll-ms', 10_000),
});

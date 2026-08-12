import { numberArg as sharedNumberArg, parseArgs } from '../cli-args.js';
import { aggregateBars } from './aggregate.js';
import { basisPointCosts } from './costs.js';
import { runReplay } from './engine.js';
import { loadBarsHttp } from './load-bars-http.js';
import { loadBars } from './load-bars.js';
import { assembleResult } from './metrics.js';
import { renderReport } from './report.js';
import { saveResult } from './save-result.js';
import { buildStrategy } from './strategy-factory.js';
import type { BacktestConfig, ClosedBar, Strategy } from './types.js';

const args = parseArgs(process.argv.slice(2));
const numberArg = (name: string, fallback: number): number =>
  sharedNumberArg(args, name, fallback);

const config: BacktestConfig = {
  symbol: args.get('symbol') ?? 'BTC-USD',
  initialEquity: args.get('equity') ?? '10000',
  positionFraction: numberArg('fraction', 1),
  takerFeeBps: numberArg('taker-bps', 60),
  makerFeeBps: numberArg('maker-bps', 40),
  slippageBps: numberArg('slippage-bps', 5),
  timeframeMinutes: numberArg('timeframe', 1),
  ...(args.get('from') ? { from: args.get('from') as string } : {}),
  ...(args.get('to') ? { to: args.get('to') as string } : {}),
};

function chooseStrategy(): Strategy<unknown> {
  const name = args.get('strategy') ?? 'buyhold';
  switch (name) {
    case 'buyhold':
      return buildStrategy({ kind: 'buyhold' });
    case 'sma':
      return buildStrategy({ kind: 'sma', fast: numberArg('fast', 20), slow: numberArg('slow', 50) });
    case 'meanrev':
      return buildStrategy({
        kind: 'meanrev',
        period: numberArg('period', 20),
        entryZ: numberArg('entry-z', 2),
        exitZ: numberArg('exit-z', 0.5),
      });
    default:
      throw new Error(`unknown strategy ${name}, expected buyhold, sma, or meanrev`);
  }
}

const databasePath = args.get('db') ?? 'data/stocky.duckdb';
const strategy = chooseStrategy();

// Prefer the running collector's API so the DuckDB lock never matters;
// fall back to the file when the collector is down. --file forces the
// file, --api forces (and names) the API. Progress goes to stderr so
// --json output stays parseable.
async function obtainBars(): Promise<ClosedBar[]> {
  const apiExplicit = args.has('api');
  const apiBase = args.get('api') ?? 'http://127.0.0.1:8787';
  if (args.get('file') !== 'true') {
    try {
      const bars = await loadBarsHttp(apiBase, config.symbol, config.from, config.to);
      console.error(`bars from collector API at ${apiBase}`);
      return bars;
    } catch (error) {
      if (apiExplicit) throw error;
      console.error('collector API unreachable, reading the database file directly');
    }
  }
  return loadBars(databasePath, config.symbol, config.from, config.to);
}

let bars: ClosedBar[];
try {
  bars = await obtainBars();
  const timeframe = config.timeframeMinutes ?? 1;
  if (timeframe > 1) {
    const oneMinuteCount = bars.length;
    bars = aggregateBars(bars, timeframe);
    console.error(`aggregated ${oneMinuteCount} 1m bars into ${bars.length} ${timeframe}m bars`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
if (bars.length < 2) {
  console.error(
    `only ${bars.length} bars for ${config.symbol} in ${databasePath}; need at least 2. Is the collector still gathering?`,
  );
  process.exit(1);
}

const outcome = runReplay(strategy, bars, config, basisPointCosts(config));
const result = assembleResult(strategy, bars, config, outcome);

if (args.get('save') === 'true') {
  const id = await saveResult(result);
  console.error(`saved as ${id}`);
}

if (args.get('json') === 'true') {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderReport(result));
}

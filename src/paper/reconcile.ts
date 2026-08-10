import path from 'node:path';
import { parseArgs } from '../cli-args.js';
import { basisPointCosts } from '../backtest/costs.js';
import { runReplay } from '../backtest/engine.js';
import { loadBarsHttp } from '../backtest/load-bars-http.js';
import { loadBars } from '../backtest/load-bars.js';
import { buildStrategy } from '../backtest/strategy-factory.js';
import type { BacktestConfig, ClosedBar } from '../backtest/types.js';
import { loadStateFile } from './state-file.js';

// Proves, on demand and on live data, that a paper session and a
// backtest over the same bars are the same computation. The session
// tests pin this in fixtures; this command demonstrates it against
// whatever reality produced. A mismatch means a real bug: engine
// drift, bar mutation, or a session file from an older code version.
// In phase 5 this same shape reconciles against real fills.
//
//   npm run reconcile -- --id sma-crossover-5-20-btc-usd

const args = parseArgs(process.argv.slice(2));
const id = args.get('id');
if (!id) {
  console.error('usage: npm run reconcile -- --id <session-id>');
  process.exit(1);
}

const state = await loadStateFile(path.resolve('data', 'paper'), id);
if (!state) {
  console.error(`no paper session named ${id} in data/paper`);
  process.exit(1);
}
if (!state.lastProcessedBar) {
  console.log(`${id} has not processed any bars yet, nothing to reconcile`);
  process.exit(0);
}

const config: BacktestConfig = {
  symbol: state.config.symbol,
  initialEquity: state.config.initialEquity,
  positionFraction: state.config.positionFraction,
  takerFeeBps: state.config.takerFeeBps,
  makerFeeBps: state.config.makerFeeBps,
  slippageBps: state.config.slippageBps,
  from: state.config.startedAt,
  to: state.lastProcessedBar,
};

const apiBase = args.get('api') ?? 'http://127.0.0.1:8787';
let bars: ClosedBar[];
try {
  bars = await loadBarsHttp(apiBase, config.symbol, config.from, config.to);
} catch {
  bars = await loadBars(args.get('db') ?? 'data/stocky.duckdb', config.symbol, config.from, config.to);
}

const strategy = buildStrategy(state.config.strategy);
const outcome = runReplay(strategy, bars, config, basisPointCosts(config));

const problems: string[] = [];

if (bars.length !== state.main.equityCurve.length) {
  problems.push(
    `bar count: backtest saw ${bars.length}, paper marked ${state.main.equityCurve.length} equity points`,
  );
}

const paperFills = state.main.fills;
if (outcome.fills.length !== paperFills.length) {
  problems.push(`fill count: backtest ${outcome.fills.length}, paper ${paperFills.length}`);
}
const comparable = Math.min(outcome.fills.length, paperFills.length);
for (let i = 0; i < comparable; i += 1) {
  const backtestFill = JSON.stringify(outcome.fills[i]);
  const paperFill = JSON.stringify(paperFills[i]);
  if (backtestFill !== paperFill) {
    problems.push(`fill ${i} differs:\n  backtest ${backtestFill}\n  paper    ${paperFill}`);
    break;
  }
}

const paperCurve = state.main.equityCurve;
const shared = Math.min(outcome.equityCurve.length, paperCurve.length);
for (let i = 0; i < shared; i += 1) {
  const backtestPoint = outcome.equityCurve[i]!;
  const paperPoint = paperCurve[i]!;
  if (backtestPoint.time !== paperPoint.time || backtestPoint.equity !== paperPoint.equity) {
    problems.push(
      `equity diverges at ${backtestPoint.time}: backtest ${backtestPoint.equity}, paper ${paperPoint.equity}`,
    );
    break;
  }
}

const lastPaperEquity = paperCurve[paperCurve.length - 1]?.equity ?? state.config.initialEquity;

if (problems.length === 0) {
  console.log(
    `RECONCILED  ${id}\n` +
      `  ${bars.length} bars ${config.from} .. ${config.to}\n` +
      `  ${paperFills.length} fills identical, equity curve identical, final equity ${lastPaperEquity}`,
  );
} else {
  console.error(`MISMATCH  ${id}`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '  a mismatch means engine drift, changed bars, or a session from an older code version',
  );
  process.exit(1);
}

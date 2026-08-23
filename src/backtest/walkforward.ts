import { toUnits } from '../decimal.js';
import { numberArg, parseArgs } from '../cli-args.js';
import { aggregateBars } from './aggregate.js';
import { basisPointCosts } from './costs.js';
import { runReplay } from './engine.js';
import { splitFolds } from './folds.js';
import { loadBarsHttp } from './load-bars-http.js';
import { loadBars } from './load-bars.js';
import { maxDrawdown, totalReturnPct } from './metrics.js';
import { buildStrategy, specFromArgs } from './strategy-factory.js';
import { buyAndHold } from './strategies/buy-and-hold.js';
import type { BacktestConfig, ClosedBar, Strategy } from './types.js';

// Walk-forward stability analysis: the SAME fixed strategy evaluated
// independently across K contiguous windows of history. No parameters
// are fitted anywhere, so this is not an optimizer; it answers whether
// a result is one lucky stretch or a repeatable behavior. Each fold
// pays its own warmup, exactly like any backtest here, and each fold
// is scored against buy-and-hold on the same bars.
//
//   npm run walkforward -- --strategy sma --fast 5 --slow 20 --timeframe 60 --folds 4

const args = parseArgs(process.argv.slice(2));

const config: BacktestConfig = {
  symbol: args.get('symbol') ?? 'BTC-USD',
  initialEquity: args.get('equity') ?? '10000',
  positionFraction: numberArg(args, 'fraction', 1),
  takerFeeBps: numberArg(args, 'taker-bps', 60),
  makerFeeBps: numberArg(args, 'maker-bps', 40),
  slippageBps: numberArg(args, 'slippage-bps', 5),
  timeframeMinutes: numberArg(args, 'timeframe', 1),
  ...(args.get('from') ? { from: args.get('from') as string } : {}),
  ...(args.get('to') ? { to: args.get('to') as string } : {}),
};
const foldCount = numberArg(args, 'folds', 4);
const strategy = buildStrategy(specFromArgs(args));
const costs = basisPointCosts(config);
const initialUnits = toUnits(config.initialEquity);

let bars: ClosedBar[];
try {
  bars = await loadBarsHttp(
    args.get('api') ?? 'http://127.0.0.1:8787',
    config.symbol,
    config.from,
    config.to,
  );
} catch {
  bars = await loadBars(
    args.get('db') ?? 'data/stocky.duckdb',
    config.symbol,
    config.from,
    config.to,
  );
}
const timeframe = config.timeframeMinutes ?? 1;
if (timeframe > 1) bars = aggregateBars(bars, timeframe);

const { folds, droppedOldest } = splitFolds(bars, foldCount);
const foldSize = folds[0]?.length ?? 0;

console.log(`\nWalk-forward  ${strategy.name}  ${config.symbol}  ${timeframe}m bars`);
console.log(
  `${bars.length} bars into ${foldCount} folds of ${foldSize}` +
    (droppedOldest > 0 ? `, oldest ${droppedOldest} dropped` : ''),
);
if (foldSize < strategy.warmupBars * 3) {
  console.log(
    `Caution   folds are thin: ${strategy.warmupBars} warmup bars eat ${Math.round((strategy.warmupBars / foldSize) * 100)}% of each fold`,
  );
}
console.log('');
const header = 'fold  window                    net%     gross%   hold%    delta    fills  maxDD%';
console.log(header);

const nets: number[] = [];
const deltas: number[] = [];
for (let i = 0; i < folds.length; i += 1) {
  const foldBars = folds[i] as ClosedBar[];
  const outcome = runReplay(strategy, foldBars, config, costs);
  const hold = runReplay(buyAndHold as Strategy<unknown>, foldBars, config, costs);
  const net = totalReturnPct(initialUnits, outcome.finalEquityUnits) * 100;
  const gross = totalReturnPct(initialUnits, outcome.grossFinalEquityUnits) * 100;
  const holdNet = totalReturnPct(initialUnits, hold.finalEquityUnits) * 100;
  const delta = net - holdNet;
  const equityNumbers = outcome.equityCurve.map((point) => Number(point.equity));
  const drawdown = maxDrawdown(equityNumbers, outcome.equityCurve.map((point) => point.time));
  nets.push(net);
  deltas.push(delta);
  const window = `${(foldBars[0] as ClosedBar).bucketStart.slice(5, 16)}..${(foldBars[foldBars.length - 1] as ClosedBar).bucketStart.slice(5, 16)}`;
  const cell = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`.padStart(8);
  console.log(
    `${String(i + 1).padStart(4)}  ${window}  ${cell(net)} ${cell(gross)} ${cell(holdNet)} ${cell(delta)}  ${String(outcome.fills.length).padStart(5)}  ${(drawdown.maxDrawdownPct * 100).toFixed(2).padStart(6)}`,
  );
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const positives = nets.filter((value) => value > 0).length;
const beatHold = deltas.filter((value) => value > 0).length;
console.log('');
console.log(
  `Summary   net positive in ${positives}/${foldCount} folds (mean ${mean(nets).toFixed(2)}%, ` +
    `range ${Math.min(...nets).toFixed(2)}% .. ${Math.max(...nets).toFixed(2)}%)`,
);
console.log(
  `          beat hold in ${beatHold}/${foldCount} folds (mean delta ${mean(deltas).toFixed(2)} pts)`,
);
console.log(
  '          a strategy is only interesting when BOTH counts stay high as folds accumulate\n',
);

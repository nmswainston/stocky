import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { numberArg, parseArgs } from '../../cli-args.js';
import { fetchDailyBars } from '../alpaca.js';
import { researchConfig } from '../config.js';
import { loadDotEnv, readSecrets } from '../env.js';
import { replay, type ReplayOptions } from './replay.js';
import { renderReplay, renderScorecard } from './report.js';
import { bucketize, gradeTheses, loadSavedTheses } from './scorecard.js';

// Two reports, no Claude calls, no cost beyond Alpaca's free data plan.
//
//   npm run research:backtest -- --from 2023-01-01 --to 2026-10-31 --every 5 --hold 20 --top 5
//   npm run research:scorecard -- --horizon 20
//
// Both read daily bars from Alpaca market data. Nothing here can trade.

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const mode = args.has('scorecard') ? 'scorecard' : 'backtest';
const config = researchConfig();
const secrets = readSecrets({ needClaude: false, needSec: false });
const alpaca = { keyId: secrets.alpacaKeyId, secretKey: secrets.alpacaSecretKey };
const outDirectory = path.resolve(config.paths.researchDirectory, 'backtests');
const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
const DAY_MS = 86_400_000;

let body: string;
if (mode === 'backtest') {
  const options: ReplayOptions = {
    symbols: args.get('symbols')?.split(',').map((symbol) => symbol.trim().toUpperCase()) ?? config.watchlist,
    benchmark: config.benchmark,
    startDate: args.get('from') ?? new Date(Date.now() - 3 * 365 * DAY_MS).toISOString().slice(0, 10),
    endDate: args.get('to') ?? new Date().toISOString().slice(0, 10),
    every: numberArg(args, 'every', 5),
    hold: numberArg(args, 'hold', 20),
    top: numberArg(args, 'top', 5),
    costBps: numberArg(args, 'cost-bps', 10),
  };
  // 120 extra calendar days so the first decision has 60+ sessions of history.
  const fetchStart = new Date(Date.parse(options.startDate) - 120 * DAY_MS).toISOString().slice(0, 10);
  console.error(`fetching daily bars ${fetchStart} onward for ${options.symbols.length} symbols plus ${options.benchmark}`);
  const bars = await fetchDailyBars(alpaca, [...options.symbols, options.benchmark], fetchStart, new Date().toISOString());
  const { periods, summary } = replay(bars, options);
  body = renderReplay(options, summary, periods);
  await mkdir(outDirectory, { recursive: true });
  await writeFile(path.join(outDirectory, `backtest-${stamp}.json`), JSON.stringify({ options, summary, periods }, null, 2));
} else {
  const horizon = numberArg(args, 'horizon', 20);
  const saved = await loadSavedTheses(path.resolve(config.paths.researchDirectory));
  if (saved.length === 0) {
    body = '# Thesis scorecard\n\nNo saved theses yet. Run `npm run research` for a while first.\n';
  } else {
    const symbols = [...new Set(saved.map((item) => item.thesis.symbol))];
    const earliest = saved.map((item) => item.asOf).sort()[0] as string;
    const bars = await fetchDailyBars(alpaca, [...symbols, config.benchmark], earliest.slice(0, 10), new Date().toISOString());
    const graded = gradeTheses(saved, bars, config.benchmark, horizon);
    body = renderScorecard(horizon, graded, bucketize(graded));
  }
}

await mkdir(outDirectory, { recursive: true });
const outPath = path.join(outDirectory, `${mode}-${stamp}.md`);
await writeFile(outPath, body);
console.log(body);
console.error(`written ${outPath}`);

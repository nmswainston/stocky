import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadBarsHttp } from './backtest/load-bars-http.js';
import { loadBars } from './backtest/load-bars.js';
import type { ClosedBar } from './backtest/types.js';
import { parseArgs } from './cli-args.js';
import { config } from './config.js';
import { loadStateFile, type PaperStateFile } from './paper/state-file.js';

// Daily digest: one markdown file per UTC day summarizing collector
// data quality and every paper session's day. Deterministic given the
// stored data, so re-running a day overwrites with the same content.
//
//   npm run digest              yesterday (UTC)
//   npm run digest -- --date 2026-08-12

const args = parseArgs(process.argv.slice(2));
const date =
  args.get('date') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dayStartIso = `${date}T00:00:00.000Z`;
const dayEndMs = Date.parse(dayStartIso) + 24 * 60 * 60 * 1000;
const apiBase = args.get('api') ?? 'http://127.0.0.1:8787';
const outDirectory = path.resolve(args.get('out') ?? path.join('data', 'digests'));

const pct = (from: number, to: number): string =>
  `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(2)}%`;

async function barsFor(symbol: string): Promise<ClosedBar[]> {
  const to = new Date(dayEndMs - 60_000).toISOString();
  try {
    return await loadBarsHttp(apiBase, symbol, dayStartIso, to);
  } catch {
    return loadBars(args.get('db') ?? 'data/stocky.duckdb', symbol, dayStartIso, to);
  }
}

const lines: string[] = [`# stocky digest ${date} (UTC)`, ''];

lines.push('## Collector');
for (const symbol of config.coinbase.productIds) {
  const bars = await barsFor(symbol);
  if (bars.length === 0) {
    lines.push(`- ${symbol}: no bars`);
    continue;
  }
  const first = bars[0] as ClosedBar;
  const last = bars[bars.length - 1] as ClosedBar;
  const span = Math.round((Date.parse(last.bucketStart) - Date.parse(first.bucketStart)) / 60_000) + 1;
  const missing = span - bars.length;
  const incomplete = bars.filter((bar) => bar.complete === false).length;
  lines.push(
    `- ${symbol}: ${bars.length} bars, ${missing} missing, ${incomplete} incomplete, ` +
      `${Number(first.open).toFixed(2)} -> ${Number(last.close).toFixed(2)} (${pct(Number(first.open), Number(last.close))})`,
  );
}

function equityAt(state: PaperStateFile, book: 'main' | 'baseline', atMs: number): number {
  let value = Number(state.config.initialEquity);
  for (const point of state[book].equityCurve) {
    if (Date.parse(point.time) >= atMs) break;
    value = Number(point.equity);
  }
  return value;
}

lines.push('', '## Paper sessions');
const paperDirectory = path.resolve('data', 'paper');
let sessionIds: string[] = [];
try {
  sessionIds = (await readdir(paperDirectory))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
} catch {
  /* no sessions directory yet */
}
if (sessionIds.length === 0) lines.push('- none');
for (const id of sessionIds) {
  const state = await loadStateFile(paperDirectory, id);
  if (!state) continue;
  const initial = Number(state.config.initialEquity);
  const dayStartMs = Date.parse(dayStartIso);
  const startEq = equityAt(state, 'main', dayStartMs);
  const endEq = equityAt(state, 'main', dayEndMs);
  const holdStart = equityAt(state, 'baseline', dayStartMs);
  const holdEnd = equityAt(state, 'baseline', dayEndMs);
  const dayPts =
    ((endEq - startEq) / startEq - (holdEnd - holdStart) / holdStart) * 100;
  const fills = state.main.fills.filter((fill) => {
    const ms = Date.parse(fill.executedAtBar);
    return ms >= dayStartMs && ms < dayEndMs;
  }).length;
  const gaps = state.gaps.filter((gap) => {
    const ms = Date.parse(gap.to);
    return ms >= dayStartMs && ms < dayEndMs;
  }).length;
  const totalCurve = state.main.equityCurve;
  const total = totalCurve.length > 0 ? Number(totalCurve[totalCurve.length - 1]!.equity) : initial;
  lines.push(
    `- ${state.config.strategyName} ${state.config.symbol} ${state.config.timeframeMinutes ?? 1}m: ` +
      `day ${pct(startEq, endEq)} (${dayPts >= 0 ? '+' : ''}${dayPts.toFixed(2)} pts vs hold), ` +
      `${fills} fills, ${gaps} gaps, total ${pct(initial, total)} to ${total.toFixed(2)}`,
  );
}

lines.push(
  '',
  '_Numbers are fictional paper trading. Missing and incomplete counts are reported, never repaired._',
  '',
);

const body = lines.join('\n');
await mkdir(outDirectory, { recursive: true });
const outPath = path.join(outDirectory, `${date}.md`);
await writeFile(outPath, body);
console.log(body);
console.error(`written ${outPath}`);

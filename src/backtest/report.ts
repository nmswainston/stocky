import type { BacktestResult } from './types.js';

// Terminal rendering only. Nothing in here feeds back into any
// calculation.

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

function sparkline(values: readonly number[], width: number): string {
  if (values.length === 0) return '';
  const bucketed: number[] = [];
  for (let i = 0; i < Math.min(width, values.length); i += 1) {
    const start = Math.floor((i * values.length) / Math.min(width, values.length));
    const end = Math.floor(((i + 1) * values.length) / Math.min(width, values.length));
    const slice = values.slice(start, Math.max(end, start + 1));
    bucketed.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const min = Math.min(...bucketed);
  const max = Math.max(...bucketed);
  const range = max - min;
  return bucketed
    .map((value) => {
      const level = range === 0 ? 0 : Math.round(((value - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[level];
    })
    .join('');
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

const money = (value: string): string => Number(value).toFixed(2);

export function renderReport(result: BacktestResult): string {
  const { data, performance, trades, costs, config } = result;
  const barMs = (config.timeframeMinutes ?? 1) * 60_000;
  const spanMs = Date.parse(data.lastBar) - Date.parse(data.firstBar) + barMs;
  const spanHours = spanMs / 3_600_000;
  const lines: string[] = [];

  lines.push('');
  lines.push(
    `Backtest  ${result.strategyName}  ${config.symbol}  ${config.timeframeMinutes ?? 1}m bars`,
  );
  lines.push(
    `Data      ${data.firstBar} .. ${data.lastBar}  (${data.barCount} bars, ${data.missingBars} missing, ${data.warmupBarsExcluded} warmup)`,
  );
  if (spanHours < 24 * 30) {
    lines.push(
      `Caution   only ${spanHours < 48 ? `${spanHours.toFixed(1)} hours` : `${(spanHours / 24).toFixed(1)} days`} of data: every number below is illustrative, not evidence`,
    );
  }
  lines.push('');
  lines.push('Performance');
  lines.push(`  Initial equity   ${money(config.initialEquity)}`);
  lines.push(`  Final equity     ${money(performance.finalEquity)}`);
  lines.push(`  Total return     ${pct(performance.totalReturnPct)}`);
  lines.push(`  Annualized       ${pct(performance.annualizedReturnPct)}`);
  lines.push(`  Sharpe           ${performance.sharpeRatio === null ? 'n/a' : performance.sharpeRatio.toFixed(2)}`);
  const dd = performance.maxDrawdownDuration;
  lines.push(
    `  Max drawdown     ${pct(performance.maxDrawdownPct)}${dd ? `  (longest underwater ${dd.bars} bars, ${dd.from} .. ${dd.to})` : ''}`,
  );
  lines.push('');
  lines.push('Trades');
  lines.push(
    `  Fills ${trades.fillCount}, round trips ${trades.roundTripCount}, win rate ${pct(trades.winRate)}`,
  );
  lines.push(`  Avg win ${pct(trades.averageWinPct)}, avg loss ${pct(trades.averageLossPct)}`);
  lines.push(
    `  Open position at end: ${trades.openPositionAtEnd ? 'yes' : 'no'}; unexecuted final signal: ${trades.undecidedSignalAtEnd ? 'yes' : 'no'}`,
  );
  lines.push('');
  lines.push('Costs');
  lines.push(`  Gross return     ${pct(costs.grossReturnPct)}  (same trades, zero friction)`);
  lines.push(`  Net return       ${pct(costs.netReturnPct)}`);
  lines.push(`  Fees paid        ${money(costs.totalFees)}`);
  lines.push(`  Slippage paid    ${money(costs.totalSlippage)}`);
  lines.push('');
  lines.push(`Equity    ${sparkline(result.equityCurve.map((p) => Number(p.equity)), 60)}`);
  lines.push('');
  return lines.join('\n');
}

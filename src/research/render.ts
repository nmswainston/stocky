import type { RunResult } from './run.js';
import type { Snapshot, SourceRef, Thesis, ThesisPoint } from './types.js';

// Markdown digest. Plain enough to read in the dashboard's digest
// panel (shown as preformatted text) or any markdown viewer on a phone.

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function signed(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function renderThesis(thesis: Thesis, snapshot: Snapshot | undefined, discovered: boolean): string[] {
  const lines: string[] = [];
  const name = snapshot?.companyName ? ` (${snapshot.companyName})` : '';
  const found = discovered ? ' [new find]' : '';
  lines.push(`### ${thesis.symbol}${name}${found}: ${signed(thesis.score)}, ${thesis.confidence} confidence`, '');
  if (thesis.summary) lines.push(thesis.summary, '');

  // Number each cited source once per thesis, in order of first use.
  const footnotes: SourceRef[] = [];
  const known = new Map((snapshot?.sources ?? []).map((source) => [source.id, source]));
  const cite = (point: ThesisPoint): string => {
    const marks = point.sources.map((id) => {
      let index = footnotes.findIndex((source) => source.id === id);
      if (index === -1) {
        footnotes.push(known.get(id) ?? { id, kind: 'news', label: id });
        index = footnotes.length - 1;
      }
      return `[${index + 1}]`;
    });
    return `- ${point.point} ${marks.join('')}`;
  };

  if (thesis.bull.length > 0) lines.push('For:', ...thesis.bull.map(cite), '');
  if (thesis.bear.length > 0) lines.push('Against:', ...thesis.bear.map(cite), '');
  if (thesis.watchFor.length > 0) lines.push(`Watch for: ${thesis.watchFor.join('; ')}`, '');
  if (!thesis.verified) lines.push(`Checks flagged: ${thesis.problems.join('; ')}`, '');
  if (footnotes.length > 0) {
    lines.push('Sources:');
    footnotes.forEach((source, index) => {
      lines.push(`${index + 1}. ${trim(source.label, 110)}${source.url ? ` ${source.url}` : ''}`);
    });
    lines.push('');
  }
  return lines;
}

export function renderDigest(result: RunResult): string {
  const lines: string[] = [`# Stock research ${result.marketDate}`, ''];
  lines.push(
    '_Research only. No orders were placed, and nothing in this app can place one. Scores are an AI opinion checked against cited data, not advice._',
    '',
  );

  const spy = result.benchmark.features;
  if (spy) {
    lines.push(
      `Market: ${result.benchmark.symbol} closed ${spy.lastClose.toFixed(2)} on ${spy.lastDate}, ` +
        `${pct(spy.return5d)} over 5 days, ${pct(spy.return20d)} over 20.`,
      '',
    );
  }

  lines.push('## Theses', '');
  if (result.dryRun) {
    lines.push(
      `Dry run: no Claude calls. ${result.prompts.length} prompts built, about ` +
        `${result.prompts.reduce((sum, item) => sum + item.estimatedTokens, 0).toLocaleString('en-US')} input tokens in total.`,
      '',
    );
  } else if (result.theses.length === 0) {
    lines.push('None today.', '');
  }
  const sorted = [...result.theses].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  for (const thesis of sorted) {
    const discovered = result.rows.some((row) => row.symbol === thesis.symbol && row.discovered);
    lines.push(...renderThesis(thesis, result.snapshots.find((item) => item.symbol === thesis.symbol), discovered));
  }

  if (result.discovery) {
    const d = result.discovery;
    lines.push('## New finds', '');
    const found = result.rows.filter((row) => row.discovered);
    lines.push(
      `Scanned ${d.scanned} large US stocks beyond the watchlist; ${d.liquid} passed the price and volume checks.`,
      '',
    );
    if (found.length === 0) {
      lines.push('Nothing unusual enough to add today.', '');
    } else {
      for (const row of found) {
        lines.push(
          `- ${row.symbol}${row.companyName ? ` (${row.companyName})` : ''}: ${row.discoveryReason ?? 'unusual activity'}` +
            `${row.researched ? ', researched below' : ', not researched today'}`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## Watchlist', '');
  lines.push('| Symbol | Close | 5d | 20d | 20d vs SPY | From 50d avg | Interest | New |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  const rows = [...result.rows].sort((a, b) => b.interest - a.interest || a.symbol.localeCompare(b.symbol));
  for (const row of rows) {
    const f = row.features;
    const fresh = [
      row.newNews > 0 ? `${row.newNews} news` : '',
      ...row.newFilings,
      row.discovered ? 'new find' : '',
      row.researched ? 'researched' : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `| ${row.symbol} | ${f ? f.lastClose.toFixed(2) : 'n/a'} | ${pct(f?.return5d)} | ${pct(f?.return20d)} | ` +
        `${pct(f?.vsBenchmark20d)} | ${pct(f?.distanceFromSma50)} | ${row.interest.toFixed(1)} | ${fresh || '-'} |`,
    );
  }
  lines.push('');

  const problems = result.rows.filter((row) => row.dataProblems.length > 0);
  const scanProblems = result.discovery?.problems ?? [];
  if (result.skipped.length > 0 || problems.length > 0 || scanProblems.length > 0) {
    lines.push('## Gaps', '');
    for (const item of result.skipped) lines.push(`- ${item.symbol}: skipped, ${item.reason}`);
    for (const row of problems) lines.push(`- ${row.symbol}: ${row.dataProblems.join('; ')}`);
    for (const problem of scanProblems) lines.push(`- discovery: ${problem}`);
    lines.push('');
  }

  const models = result.budgetModel ? `${result.model} and ${result.budgetModel}` : result.model;
  lines.push('## Cost', '');
  lines.push(
    `${models}: ${result.tokens.input.toLocaleString('en-US')} input and ` +
      `${result.tokens.output.toLocaleString('en-US')} output tokens, $${result.costUsd.toFixed(3)} ` +
      `of a $${result.budgetUsd.toFixed(2)} daily cap.`,
    '',
    `_Data as of ${result.asOf}. Prices from Alpaca's free IEX feed; filings and quarterly figures from SEC EDGAR._`,
    '',
  );
  return lines.join('\n');
}

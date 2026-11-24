import type { ReplayOptions, ReplayPeriod, ReplaySummary } from './replay.js';
import type { GradedThesis, ScoreBucket } from './scorecard.js';

// Markdown for both reports. The caveats are part of the output on
// purpose: a backtest number without them reads as a promise.

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

export function renderReplay(options: ReplayOptions, summary: ReplaySummary, periods: ReplayPeriod[]): string {
  const lines = [
    `# Research backtest ${options.startDate} to ${options.endDate}`,
    '',
    `Every ${options.every} sessions, the rule score picks the top ${options.top} of ${summary.eligibleSymbols} stocks, ` +
      `holds them ${options.hold} sessions, and pays ${options.costBps} bps a round trip. Compared with ${options.benchmark}.`,
    '',
    '## Results',
    '',
    `- Decisions: ${summary.periods}`,
    `- Picks vs ${options.benchmark}, average per hold: ${pct(summary.picksVsBenchmark)}`,
    `- Picks vs the whole watchlist, average per hold: ${pct(summary.picksVsUniverse)}`,
    `- Holds where picks beat ${options.benchmark}: ${(summary.hitRate * 100).toFixed(0)}%`,
    `- Compounded, non-overlapping holds: picks ${pct(summary.picksGrowth)}, ${options.benchmark} ${pct(summary.benchmarkGrowth)}`,
    `- Screen lift: screened names moved ${summary.screenLift.toFixed(2)}x as much as the rest (above 1 means the screen finds action)`,
    '',
    '## Read this before trusting any of it',
    '',
    '- **Survivorship bias.** The watchlist is today\'s big winners, chosen with hindsight. Every strategy on it looks better than it would have in real time.',
    '- **Rules only.** This tests the screen and a plain momentum score. It does not test Claude: a model asked about past dates already knows what happened next. Claude gets graded forward, by `npm run research:scorecard`.',
    '- **Prices only.** History here has no news or filings, so the screen runs on its price half.',
    '- **Small samples lie.** Under about 50 decisions, a few lucky holds can carry the whole result.',
    '',
    '## Last 10 decisions',
    '',
    '| Entry | Exit | Picks | Picks | SPY |',
    '| --- | --- | --- | ---: | ---: |',
  ];
  for (const period of periods.slice(-10)) {
    lines.push(
      `| ${period.date} | ${period.exitDate} | ${period.picks.map((pick) => pick.symbol).join(', ')} | ` +
        `${pct(period.picksForward)} | ${pct(period.benchmarkForward)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderScorecard(horizon: number, graded: GradedThesis[], buckets: ScoreBucket[]): string {
  const live = graded.filter((row) => !row.asOfRun);
  const lines = [
    `# Thesis scorecard, ${horizon} sessions after each thesis`,
    '',
    `${graded.length} theses graded (${live.length} from live daily runs, ${graded.length - live.length} from --as-of runs). ` +
      'Excess is the stock\'s return minus SPY\'s over the same sessions.',
    '',
    '| Score | Theses | Average excess | Beat SPY |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const bucket of buckets) {
    lines.push(
      `| ${bucket.label} | ${bucket.count} | ${bucket.count ? pct(bucket.meanExcess) : 'n/a'} | ` +
        `${bucket.count ? `${(bucket.hitRate * 100).toFixed(0)}%` : 'n/a'} |`,
    );
  }
  lines.push(
    '',
    'What good looks like: positive theses beat SPY on average, negative ones trail it, and the gap holds month after month.',
    '',
    '- **Live theses are the real test.** They were written before the outcome existed.',
    '- **As-of theses are contaminated.** The model may remember what happened after the date it was shown. Treat them as a smoke test of the pipeline, not evidence.',
  );
  if (live.length < 100) {
    lines.push(`- **Too early to judge.** ${live.length} live theses so far; give it a few hundred (two or three months) before reading much into this.`);
  }
  lines.push('');
  return lines.join('\n');
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, numberArg } from '../cli-args.js';
import { claudeThesisWriter } from './agent.js';
import { fetchDailyBars, fetchNews } from './alpaca.js';
import { loadSavedTheses, scorecardSummary } from './backtest/scorecard.js';
import { researchConfig } from './config.js';
import { Edgar } from './edgar.js';
import { loadDotEnv, readSecrets } from './env.js';
import { heartbeatPinger } from './heartbeat.js';
import { pushMessage, sendPush } from './notify.js';
import { renderDigest } from './render.js';
import { runResearch, type RunSources } from './run.js';
import type { PriorThesis } from './types.js';

// Daily stock research digest. Research only: reads market data, news
// and SEC filings, asks Claude for a cited thesis on the most active
// names, and writes a markdown digest. It never talks to a broker.
//
//   npm run research                      full run (needs all keys in .env)
//   npm run research -- --dry-run         fetch data and build prompts, no Claude calls
//   npm run research -- --symbols AAPL,MSFT --limit 2   (skips discovery)
//   npm run research -- --no-discovery    watchlist only, no wider scan
//   npm run research -- --as-of 2025-03-03 --limit 3
//       research as if it were that morning; saved apart from live runs
//       and marked, because the model may remember what came next

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const dryRun = args.has('dry-run');
const asOfDate = args.get('as-of');
if (asOfDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  throw new Error(`--as-of expects YYYY-MM-DD, got ${asOfDate}`);
}
// 12:30 UTC is the timer's usual run time: before the US open all year.
const now = asOfDate ? new Date(`${asOfDate}T12:30:00.000Z`) : new Date();

// Dead-man alert for the scheduled run only. Dry runs and as-of replays
// are manual experiments and must not touch the check: a stray success
// ping from one could hide a real run that never happened.
const scheduledStyleRun = !dryRun && asOfDate === undefined;
const heartbeat = heartbeatPinger(scheduledStyleRun ? process.env.RESEARCH_HEARTBEAT_URL : null, {
  log: (line) => console.error(line),
});

try {
  await main();
  await heartbeat.success();
} catch (error) {
  await heartbeat.fail();
  throw error;
}

async function main(): Promise<void> {
  const config = researchConfig();
  const secrets = readSecrets({ needClaude: !dryRun });
  const symbols = args.get('symbols')?.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const limit = args.has('limit') ? numberArg(args, 'limit', config.researchPerDay) : undefined;

  const alpaca = { keyId: secrets.alpacaKeyId, secretKey: secrets.alpacaSecretKey };
  const edgar = new Edgar(secrets.secUserAgent, config.paths.edgarCacheDirectory);
  const sources: RunSources = {
    dailyBars: (list, start, end) => fetchDailyBars(alpaca, list, start, end),
    news: (symbol, start, end, max) => fetchNews(alpaca, [symbol], start, end, max),
    recentNews: (list, start, end, max) => fetchNews(alpaca, list, start, end, max),
    company: (symbol) => edgar.lookup(symbol),
    filings: (cik, since, asOfDate) => edgar.recentFilings(cik, since, asOfDate),
    facts: (cik, asOfDate, quarters) => edgar.quarterlyFacts(cik, asOfDate, quarters),
  };
  const writer =
    dryRun || !secrets.anthropicApiKey
      ? null
      : claudeThesisWriter({
          apiKey: secrets.anthropicApiKey,
          model: config.model,
          effort: config.effort,
          maxOutputTokens: config.maxOutputTokens,
        });

  const runOptions: Parameters<typeof runResearch>[3] = {
    now,
    log: (line) => console.error(line),
  };
  if (symbols && symbols.length > 0) runOptions.symbols = symbols;
  if (limit !== undefined) runOptions.limit = limit;
  if (args.has('no-discovery')) runOptions.discover = false;

  // Thesis memory: the model's most recent live thesis per symbol goes
  // back into its prompt. Strictly earlier than this run's as-of time,
  // so an --as-of replay can never see a thesis from its future.
  try {
    const saved = await loadSavedTheses(path.resolve(config.paths.researchDirectory));
    const priorTheses = new Map<string, PriorThesis>();
    const cutoff = now.toISOString();
    const usable = saved
      .filter((item) => !item.asOfRun && item.asOf < cutoff)
      .sort((a, b) => a.asOf.localeCompare(b.asOf));
    for (const item of usable) {
      priorTheses.set(item.thesis.symbol, {
        asOf: item.asOf,
        score: item.thesis.score,
        confidence: item.thesis.confidence,
        summary: item.thesis.summary,
        watchFor: item.thesis.watchFor,
      });
    }
    if (priorTheses.size > 0) runOptions.priorTheses = priorTheses;
  } catch (error) {
    console.error(`prior theses unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = await runResearch(config, sources, writer, runOptions);

  // Everything the digest was built from, so any score can be traced back
  // to the exact data and prompt behind it.
  const runDirectory = asOfDate
    ? path.resolve(config.paths.researchDirectory, 'as-of', result.marketDate)
    : path.resolve(config.paths.researchDirectory, result.marketDate);

  // Real and dry runs share the day's folder and the last writer used
  // to win, so a dry run after a real one silently destroyed the day's
  // theses and exact prompts (it happened 2026-11-27). A dry run now
  // saves nothing once a real run is on file; its digest below, with
  // the -dry-run suffix, is still written and printed.
  let preserveRealRun = false;
  if (result.dryRun) {
    try {
      const existing = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8')) as { dryRun?: boolean };
      preserveRealRun = existing.dryRun === false;
    } catch {
      /* nothing saved for this date yet */
    }
  }
  if (preserveRealRun) {
    console.error(`real run already saved for ${result.marketDate}; dry-run files not written`);
  } else {
    await mkdir(path.join(runDirectory, 'prompts'), { recursive: true });
    await writeFile(path.join(runDirectory, 'theses.json'), JSON.stringify(result.theses, null, 2));
    await writeFile(path.join(runDirectory, 'snapshots.json'), JSON.stringify(result.snapshots, null, 2));
    await writeFile(
      path.join(runDirectory, 'run.json'),
      JSON.stringify(
        {
          asOf: result.asOf,
          model: result.model,
          budgetModel: result.budgetModel,
          dryRun: result.dryRun,
          asOfRun: asOfDate !== undefined,
          costUsd: result.costUsd,
          budgetUsd: result.budgetUsd,
          tokens: result.tokens,
          skipped: result.skipped,
          discovery: result.discovery,
          watchlist: result.rows,
        },
        null,
        2,
      ),
    );
    for (const item of result.prompts) {
      await writeFile(path.join(runDirectory, 'prompts', `${item.symbol}.txt`), item.prompt);
    }
  }

  const digest = renderDigest(result);
  const digestsDirectory = path.resolve(config.paths.digestsDirectory);
  await mkdir(digestsDirectory, { recursive: true });
  const suffix = `${asOfDate ? '-as-of' : ''}${result.dryRun ? '-dry-run' : ''}`;
  const digestPath = path.join(digestsDirectory, `research-${result.marketDate}${suffix}.md`);
  await writeFile(digestPath, digest);
  console.log(digest);
  console.error(`written ${digestPath}`);

  // Refresh the track record the research page shows: every live thesis
  // graded against the benchmark at a few horizons. Free market data,
  // no Claude calls, and a failure here never fails a saved run.
  if (scheduledStyleRun) {
    try {
      const saved = await loadSavedTheses(path.resolve(config.paths.researchDirectory));
      const live = saved.filter((item) => !item.asOfRun);
      if (live.length > 0) {
        const thesisSymbols = [...new Set(live.map((item) => item.thesis.symbol))];
        const earliest = (live.map((item) => item.asOf).sort()[0] as string).slice(0, 10);
        const gradeBars = await fetchDailyBars(alpaca, [...thesisSymbols, config.benchmark], earliest, new Date().toISOString());
        const summary = scorecardSummary(saved, gradeBars, config.benchmark, [5, 20, 60], new Date().toISOString());
        await writeFile(
          path.resolve(config.paths.researchDirectory, 'scorecard.json'),
          JSON.stringify(summary, null, 2),
        );
        console.error(`scorecard refreshed: ${live.length} live theses`);
      }
    } catch (error) {
      console.error(`scorecard refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phone push for the scheduled run only, after everything is saved:
  // the digest is the record, the push is just the doorbell.
  if (scheduledStyleRun) {
    await sendPush(process.env.RESEARCH_NTFY_URL, pushMessage(result), {
      clickUrl: process.env.RESEARCH_PAGE_URL ?? null,
      log: (line) => console.error(line),
    });
  }
}

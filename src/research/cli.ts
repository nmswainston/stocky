import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, numberArg } from '../cli-args.js';
import { claudeThesisWriter } from './agent.js';
import { fetchDailyBars, fetchNews } from './alpaca.js';
import { researchConfig } from './config.js';
import { Edgar } from './edgar.js';
import { loadDotEnv, readSecrets } from './env.js';
import { renderDigest } from './render.js';
import { runResearch, type RunSources } from './run.js';

// Daily stock research digest. Research only: reads market data, news
// and SEC filings, asks Claude for a cited thesis on the most active
// names, and writes a markdown digest. It never talks to a broker.
//
//   npm run research                      full run (needs all keys in .env)
//   npm run research -- --dry-run         fetch data and build prompts, no Claude calls
//   npm run research -- --symbols AAPL,MSFT --limit 2
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
const config = researchConfig();
const secrets = readSecrets({ needClaude: !dryRun });
const symbols = args.get('symbols')?.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
const limit = args.has('limit') ? numberArg(args, 'limit', config.researchPerDay) : undefined;

const alpaca = { keyId: secrets.alpacaKeyId, secretKey: secrets.alpacaSecretKey };
const edgar = new Edgar(secrets.secUserAgent, config.paths.edgarCacheDirectory);
const sources: RunSources = {
  dailyBars: (list, start, end) => fetchDailyBars(alpaca, list, start, end),
  news: (symbol, start, end, max) => fetchNews(alpaca, [symbol], start, end, max),
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

const result = await runResearch(config, sources, writer, runOptions);

// Everything the digest was built from, so any score can be traced back
// to the exact data and prompt behind it.
const runDirectory = asOfDate
  ? path.resolve(config.paths.researchDirectory, 'as-of', result.marketDate)
  : path.resolve(config.paths.researchDirectory, result.marketDate);
await mkdir(path.join(runDirectory, 'prompts'), { recursive: true });
await writeFile(path.join(runDirectory, 'theses.json'), JSON.stringify(result.theses, null, 2));
await writeFile(path.join(runDirectory, 'snapshots.json'), JSON.stringify(result.snapshots, null, 2));
await writeFile(
  path.join(runDirectory, 'run.json'),
  JSON.stringify(
    {
      asOf: result.asOf,
      model: result.model,
      dryRun: result.dryRun,
      asOfRun: asOfDate !== undefined,
      costUsd: result.costUsd,
      budgetUsd: result.budgetUsd,
      tokens: result.tokens,
      skipped: result.skipped,
      watchlist: result.rows,
    },
    null,
    2,
  ),
);
for (const item of result.prompts) {
  await writeFile(path.join(runDirectory, 'prompts', `${item.symbol}.txt`), item.prompt);
}

const digest = renderDigest(result);
const digestsDirectory = path.resolve(config.paths.digestsDirectory);
await mkdir(digestsDirectory, { recursive: true });
const suffix = `${asOfDate ? '-as-of' : ''}${result.dryRun ? '-dry-run' : ''}`;
const digestPath = path.join(digestsDirectory, `research-${result.marketDate}${suffix}.md`);
await writeFile(digestPath, digest);
console.log(digest);
console.error(`written ${digestPath}`);

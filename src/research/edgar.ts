import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Filing, QuarterFact } from './types.js';

// SEC EDGAR: free JSON, no key. The SEC asks every client to send a
// User-Agent with a contact email and to stay under 10 requests a
// second; requests here run one at a time with a short pause.

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PAUSE_MS = 150;
const CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export class Edgar {
  private tickerMap: Map<string, { cik: number; title: string }> | null = null;

  constructor(
    private readonly userAgent: string,
    private readonly cacheDirectory: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async getJson(url: string, cacheName: string): Promise<unknown> {
    const cachePath = path.join(this.cacheDirectory, cacheName);
    try {
      const info = await stat(cachePath);
      if (Date.now() - info.mtimeMs < CACHE_MAX_AGE_MS) {
        return JSON.parse(await readFile(cachePath, 'utf8'));
      }
    } catch {
      /* not cached yet */
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const response = await this.fetchImpl(url, {
      headers: { 'User-Agent': this.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`SEC EDGAR answered ${response.status} for ${url}`);
    const text = await response.text();
    await mkdir(this.cacheDirectory, { recursive: true });
    await writeFile(cachePath, text);
    return JSON.parse(text);
  }

  async lookup(symbol: string): Promise<{ cik: number; title: string } | null> {
    if (!this.tickerMap) {
      const raw = (await this.getJson('https://www.sec.gov/files/company_tickers.json', 'company_tickers.json')) as Record<
        string,
        { cik_str: number; ticker: string; title: string }
      >;
      this.tickerMap = new Map(
        Object.values(raw).map((row) => [row.ticker.toUpperCase(), { cik: row.cik_str, title: row.title }]),
      );
    }
    // EDGAR writes class shares with a dash (BRK-B); Alpaca uses a dot.
    return this.tickerMap.get(symbol.toUpperCase().replace('.', '-')) ?? null;
  }

  async recentFilings(cik: number, sinceDate: string, asOfDate: string): Promise<Filing[]> {
    const padded = String(cik).padStart(10, '0');
    const raw = (await this.getJson(
      `https://data.sec.gov/submissions/CIK${padded}.json`,
      `submissions-${padded}.json`,
    )) as { filings?: { recent?: Record<string, unknown[]> } };
    return parseRecentFilings(cik, raw.filings?.recent ?? {}, sinceDate, asOfDate);
  }

  async quarterlyFacts(cik: number, asOfDate: string, quarters: number): Promise<QuarterFact[]> {
    const padded = String(cik).padStart(10, '0');
    const raw = (await this.getJson(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
      `companyfacts-${padded}.json`,
    )) as CompanyFacts;
    return extractQuarterlyFacts(raw, asOfDate, quarters);
  }
}

const INTERESTING_FORMS = new Set(['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A', 'DEF 14A', 'S-1']);

export function parseRecentFilings(
  cik: number,
  recent: Record<string, unknown[]>,
  sinceDate: string,
  asOfDate: string,
): Filing[] {
  const accessions = (recent.accessionNumber ?? []) as string[];
  const forms = (recent.form ?? []) as string[];
  const filed = (recent.filingDate ?? []) as string[];
  const reports = (recent.reportDate ?? []) as string[];
  const documents = (recent.primaryDocument ?? []) as string[];
  const filings: Filing[] = [];
  for (let i = 0; i < accessions.length; i += 1) {
    const form = forms[i] ?? '';
    const filedOn = filed[i] ?? '';
    // Strictly before the run date: a filing that lands mid-run is
    // tomorrow's news, which keeps re-runs reproducible.
    if (!INTERESTING_FORMS.has(form) || filedOn < sinceDate || filedOn >= asOfDate) continue;
    const accession = accessions[i] as string;
    const folder = accession.replaceAll('-', '');
    filings.push({
      accession,
      form,
      filedOn,
      reportDate: reports[i] ? (reports[i] as string) : null,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${documents[i] ?? ''}`,
    });
  }
  return filings.sort((a, b) => b.filedOn.localeCompare(a.filedOn));
}

interface FactRow {
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
}

interface CompanyFacts {
  facts?: Record<string, Record<string, { units?: Record<string, FactRow[]> }>>;
}

// Companies tag revenue under different names; first one with data wins.
const CONCEPTS: { label: string; tags: string[]; unit: string }[] = [
  {
    label: 'revenue',
    tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
    unit: 'USD',
  },
  { label: 'netIncome', tags: ['NetIncomeLoss'], unit: 'USD' },
  { label: 'epsDiluted', tags: ['EarningsPerShareDiluted'], unit: 'USD/shares' },
];

function days(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

// Three-month periods only (Q4 is not reported on its own; it shows up
// inside the 10-K's annual figure, so it is simply absent here), filed
// before the run date, one row per period end, newest first.
export function extractQuarterlyFacts(raw: CompanyFacts, asOfDate: string, quarters: number): QuarterFact[] {
  const gaap = raw.facts?.['us-gaap'] ?? {};
  const out: QuarterFact[] = [];
  for (const concept of CONCEPTS) {
    for (const tag of concept.tags) {
      const rows = gaap[tag]?.units?.[concept.unit] ?? [];
      const byEnd = new Map<string, FactRow>();
      for (const row of rows) {
        if (!row.start || row.filed >= asOfDate) continue;
        const span = days(row.start, row.end);
        if (span < 80 || span > 100) continue;
        const existing = byEnd.get(row.end);
        // Keep the original filing of a period, not later restatements:
        // the original is what the market saw at the time.
        if (!existing || row.filed < existing.filed) byEnd.set(row.end, row);
      }
      if (byEnd.size === 0) continue;
      const newest = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, quarters);
      for (const row of newest) {
        out.push({ concept: concept.label, periodEnd: row.end, value: row.val, form: row.form, filedOn: row.filed });
      }
      break;
    }
  }
  return out;
}

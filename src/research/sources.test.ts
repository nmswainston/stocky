import { describe, expect, it } from 'vitest';
import { fetchDailyBars, fetchNews } from './alpaca.js';
import { extractQuarterlyFacts, parseRecentFilings } from './edgar.js';

function fakeFetch(pages: unknown[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = pages[calls.length - 1] ?? {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { impl, calls };
}

describe('alpaca market data', () => {
  it('pages through daily bars and only calls the data host', async () => {
    const { impl, calls } = fakeFetch([
      { bars: { AAPL: [{ t: '2026-08-03T04:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: 'p2' },
      { bars: { AAPL: [{ t: '2026-08-04T04:00:00Z', o: 2, h: 3, l: 2, c: 3, v: 20 }] }, next_page_token: null },
    ]);
    const bars = await fetchDailyBars({ keyId: 'k', secretKey: 's' }, ['AAPL'], '2026-08-01', '2026-08-05T00:00:00Z', impl);
    expect(bars.get('AAPL')?.map((bar) => bar.date)).toEqual(['2026-08-03', '2026-08-04']);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(new URL(call.url).host).toBe('data.alpaca.markets');
    expect(new URL(calls[0]!.url).searchParams.get('feed')).toBe('iex');
    expect(new URL(calls[1]!.url).searchParams.get('page_token')).toBe('p2');
  });

  it('caps news at the requested count', async () => {
    const news = Array.from({ length: 50 }, (_, index) => ({
      id: index,
      headline: `h${index}`,
      created_at: '2026-08-04T10:00:00Z',
    }));
    const { impl } = fakeFetch([{ news, next_page_token: 'more' }]);
    const items = await fetchNews({ keyId: 'k', secretKey: 's' }, ['AAPL'], 'a', 'b', 15, impl);
    expect(items).toHaveLength(15);
    expect(items[0]?.id).toBe('0');
  });

  it('reports an HTTP failure without leaking the keys', async () => {
    const impl = async () => new Response('forbidden', { status: 403 });
    const error = await fetchDailyBars({ keyId: 'KEYID123', secretKey: 'SECRET456' }, ['AAPL'], 'a', 'b', impl).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/403/);
    expect((error as Error).message).not.toMatch(/SECRET456|KEYID123/);
  });
});

describe('SEC EDGAR parsing', () => {
  const recent = {
    accessionNumber: ['0001-26-000003', '0001-26-000002', '0001-26-000001'],
    form: ['10-Q', '4', '8-K'],
    filingDate: ['2026-09-02', '2026-08-20', '2026-08-01'],
    reportDate: ['2026-06-30', '', ''],
    primaryDocument: ['q.htm', 'f4.xml', 'k.htm'],
  };

  it('keeps interesting forms filed before the run date', () => {
    const filings = parseRecentFilings(320193, recent, '2026-07-01', '2026-09-02');
    // The 10-Q is filed on the run date itself, so it is excluded; Form 4 is not interesting.
    expect(filings.map((filing) => filing.form)).toEqual(['8-K']);
    expect(filings[0]?.url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000126000001/k.htm');
  });

  it('extracts three month periods, filed before the run date, newest first', () => {
    const facts = extractQuarterlyFacts(
      {
        facts: {
          'us-gaap': {
            Revenues: {
              units: {
                USD: [
                  { start: '2026-01-01', end: '2026-03-31', val: 100, form: '10-Q', filed: '2026-05-01' },
                  { start: '2026-04-01', end: '2026-06-30', val: 120, form: '10-Q', filed: '2026-08-01' },
                  // Six month figure: not a quarter.
                  { start: '2026-01-01', end: '2026-06-30', val: 220, form: '10-Q', filed: '2026-08-01' },
                  // Filed after the run date: the snapshot must not see it.
                  { start: '2026-07-01', end: '2026-09-30', val: 130, form: '10-Q', filed: '2026-11-01' },
                  // Restatement of Q1 filed later: the original wins.
                  { start: '2026-01-01', end: '2026-03-31', val: 101, form: '10-Q', filed: '2026-08-01' },
                ],
              },
            },
          },
        },
      },
      '2026-09-01',
      5,
    );
    expect(facts.map((fact) => [fact.periodEnd, fact.value])).toEqual([
      ['2026-06-30', 120],
      ['2026-03-31', 100],
    ]);
    expect(facts.every((fact) => fact.concept === 'revenue')).toBe(true);
  });
});

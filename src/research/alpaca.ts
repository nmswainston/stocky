import type { DailyBar, NewsItem } from './types.js';

// Alpaca MARKET DATA only (data.alpaca.markets). This file deliberately
// knows no trading host and no order endpoint; no-orders.test.ts fails
// the build if one appears anywhere under src/research.
//
// Free "Basic" data plan: IEX feed, history back to 2016, 200 calls a
// minute. The digest needs one bars call and one news call per batch.

const DATA_BASE = 'https://data.alpaca.markets';

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(
  credentials: AlpacaCredentials,
  url: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      'APCA-API-KEY-ID': credentials.keyId,
      'APCA-API-SECRET-KEY': credentials.secretKey,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // Body text can carry a reason ("forbidden", "subscription does not
    // permit"). Never echo request headers, which hold the keys.
    const reason = (await response.text()).slice(0, 200);
    throw new Error(`Alpaca data answered ${response.status} for ${new URL(url).pathname}: ${reason}`);
  }
  return response.json();
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function fetchDailyBars(
  credentials: AlpacaCredentials,
  symbols: string[],
  startDate: string,
  endIso: string,
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, DailyBar[]>> {
  const result = new Map<string, DailyBar[]>(symbols.map((symbol) => [symbol, []]));
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe: '1Day',
      start: startDate,
      end: endIso,
      feed: 'iex',
      adjustment: 'split',
      limit: '10000',
    });
    if (pageToken) params.set('page_token', pageToken);
    const payload = (await getJson(credentials, `${DATA_BASE}/v2/stocks/bars?${params}`, fetchImpl)) as {
      bars?: Record<string, RawBar[]> | null;
      next_page_token?: string | null;
    };
    for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
      const list = result.get(symbol) ?? [];
      for (const bar of bars) {
        list.push({
          date: bar.t.slice(0, 10),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        });
      }
      result.set(symbol, list);
    }
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken);
  for (const list of result.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

interface RawNews {
  id: number | string;
  headline: string;
  summary?: string;
  source?: string;
  created_at: string;
  url?: string;
  symbols?: string[];
}

// Newest first. Alpaca returns at most 50 items a page; the cap keeps a
// news-heavy day from blowing up prompt size.
export async function fetchNews(
  credentials: AlpacaCredentials,
  symbols: string[],
  startIso: string,
  endIso: string,
  maxItems: number,
  fetchImpl: FetchLike = fetch,
): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      start: startIso,
      end: endIso,
      sort: 'desc',
      limit: '50',
      include_content: 'false',
    });
    if (pageToken) params.set('page_token', pageToken);
    const payload = (await getJson(credentials, `${DATA_BASE}/v1beta1/news?${params}`, fetchImpl)) as {
      news?: RawNews[];
      next_page_token?: string | null;
    };
    for (const raw of payload.news ?? []) {
      items.push({
        id: String(raw.id),
        headline: raw.headline,
        summary: (raw.summary ?? '').slice(0, 600),
        source: raw.source ?? 'unknown',
        createdAt: raw.created_at,
        url: raw.url ?? '',
        symbols: raw.symbols ?? [],
      });
    }
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken && items.length < maxItems);
  return items.slice(0, maxItems);
}

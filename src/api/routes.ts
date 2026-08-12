import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { logger } from '../logger.js';

// All routes the collector answers. Reads only: nothing here can write
// to storage, place an order, or touch the collection hot path beyond
// running a bounded query on the shared connection.

const log = logger.child({ module: 'api' });

export interface StatusSnapshot {
  uptimeSeconds: number;
  connected: boolean;
  messagesReceived: number;
  lastMessageAt: string | null;
  reconnectCount: number;
  gapCount: number;
  duplicatesSkipped: number;
  lateTrades: number;
  buffered: number;
  tradesWritten: number;
  barsWritten: number;
}

export interface ApiDependencies {
  snapshot: () => StatusSnapshot;
  readBars: (
    symbol: string,
    from?: string,
    to?: string,
    limit?: number,
    direction?: 'tail' | 'head',
  ) => Promise<unknown[]>;
  readTicker: () => Promise<unknown[]>;
  readRecentTrades: (symbol: string, limit?: number) => Promise<unknown[]>;
  publicDirectory: string;
  backtestsDirectory: string;
  paperDirectory: string;
  vendorFiles: Record<string, string>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function sendFile(response: http.ServerResponse, filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

// Saved backtest files are named <id>.json. The listing parses each file
// for a summary; fine at the scale of hand-run backtests.
async function listBacktests(directory: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const summaries: unknown[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      summaries.push({
        id: name.slice(0, -'.json'.length),
        savedAt: parsed.savedAt ?? null,
        strategyName: parsed.result?.strategyName ?? 'unknown',
        symbol: parsed.result?.config?.symbol ?? 'unknown',
        totalReturnPct: parsed.result?.performance?.totalReturnPct ?? null,
        barCount: parsed.result?.data?.barCount ?? null,
      });
    } catch (error) {
      log.warn({ err: error, name }, 'unreadable backtest file skipped');
    }
  }
  return summaries;
}

async function listPaperSessions(directory: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const sessions: unknown[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      const curve = parsed.main?.equityCurve ?? [];
      sessions.push({
        id: parsed.config?.id ?? name.slice(0, -'.json'.length),
        strategyName: parsed.config?.strategyName ?? 'unknown',
        symbol: parsed.config?.symbol ?? 'unknown',
        timeframeMinutes: parsed.config?.timeframeMinutes ?? 1,
        initialEquity: parsed.config?.initialEquity ?? null,
        equity: curve.length > 0 ? curve[curve.length - 1].equity : parsed.config?.initialEquity,
        lastProcessedBar: parsed.lastProcessedBar ?? null,
        updatedAt: parsed.updatedAt ?? null,
        fillCount: parsed.main?.fills?.length ?? 0,
        gapCount: parsed.gaps?.length ?? 0,
      });
    } catch (error) {
      log.warn({ err: error, name }, 'unreadable paper session skipped');
    }
  }
  return sessions;
}

export function createRequestHandler(deps: ApiDependencies): http.RequestListener {
  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const route = url.pathname;
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }

      if (route === '/status' || route === '/api/status') {
        sendJson(response, 200, deps.snapshot());
        return;
      }

      if (route === '/api/bars') {
        const symbol = url.searchParams.get('symbol') ?? 'BTC-USD';
        const from = url.searchParams.get('from') ?? undefined;
        const to = url.searchParams.get('to') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? '2000');
        const direction = url.searchParams.get('direction') === 'head' ? 'head' : 'tail';
        const bars = await deps.readBars(symbol, from, to, limit, direction);
        sendJson(response, 200, { symbol, count: bars.length, bars });
        return;
      }

      if (route === '/api/backtests') {
        sendJson(response, 200, { backtests: await listBacktests(deps.backtestsDirectory) });
        return;
      }

      if (route === '/api/ticker') {
        sendJson(response, 200, { ticker: await deps.readTicker() });
        return;
      }

      if (route === '/api/trades') {
        const symbol = url.searchParams.get('symbol') ?? 'BTC-USD';
        const limit = Number(url.searchParams.get('limit') ?? '30');
        sendJson(response, 200, { symbol, trades: await deps.readRecentTrades(symbol, limit) });
        return;
      }

      if (route === '/api/paper') {
        sendJson(response, 200, { sessions: await listPaperSessions(deps.paperDirectory) });
        return;
      }

      const paperMatch = /^\/api\/paper\/([A-Za-z0-9._-]+)$/.exec(route);
      if (paperMatch) {
        const filePath = path.join(deps.paperDirectory, `${paperMatch[1]}.json`);
        if (!(await sendFile(response, filePath))) {
          sendJson(response, 404, { error: 'paper session not found' });
        }
        return;
      }

      const backtestMatch = /^\/api\/backtests\/([A-Za-z0-9._-]+)$/.exec(route);
      if (backtestMatch) {
        const filePath = path.join(deps.backtestsDirectory, `${backtestMatch[1]}.json`);
        if (!(await sendFile(response, filePath))) {
          sendJson(response, 404, { error: 'backtest not found' });
        }
        return;
      }

      const vendorTarget = deps.vendorFiles[route];
      if (vendorTarget) {
        if (!(await sendFile(response, vendorTarget))) {
          sendJson(response, 404, { error: 'vendor file missing, run npm install' });
        }
        return;
      }

      // Static dashboard files, resolved strictly inside publicDirectory.
      const relative = route === '/' ? 'index.html' : route.slice(1);
      const resolved = path.resolve(deps.publicDirectory, relative);
      if (!resolved.startsWith(path.resolve(deps.publicDirectory) + path.sep) &&
          resolved !== path.resolve(deps.publicDirectory, 'index.html')) {
        sendJson(response, 403, { error: 'forbidden' });
        return;
      }
      if (!(await sendFile(response, resolved))) {
        sendJson(response, 404, { error: 'not found' });
      }
    })().catch((error) => {
      log.error({ err: error, url: request.url }, 'request failed');
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.end();
    });
  };
}

// Pure translation from raw Coinbase JSON to typed domain objects.
// No IO, no clocks, no logging: receivedAt is passed in by the caller.
//
// Assumed envelope shape (verify against the Advanced Trade WS docs):
//   { channel, timestamp, sequence_num, events: [...] }
// market_trades events:
//   { type: 'snapshot' | 'update', trades: [{ trade_id, product_id, price, size, time, side }] }

export interface Trade {
  tradeId: string;
  symbol: string;
  // price and size stay as strings all the way to DuckDB, which casts them
  // to DECIMAL. Parsing to a JS number would introduce float error.
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  exchangeTime: string;
  receivedAt: string;
  sequenceNum: number;
}

export type ParsedMessage =
  | { kind: 'trades'; sequenceNum: number; eventType: 'snapshot' | 'update'; trades: Trade[]; skipped: number }
  | { kind: 'heartbeat'; sequenceNum: number }
  | { kind: 'subscriptions'; sequenceNum: number }
  | { kind: 'error'; message: string }
  | { kind: 'unknown'; channel: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTrade(raw: unknown, receivedAt: string, sequenceNum: number): Trade | null {
  if (!isRecord(raw)) return null;
  const tradeId = asString(raw.trade_id);
  const symbol = asString(raw.product_id);
  const price = asString(raw.price);
  const size = asString(raw.size);
  const time = asString(raw.time);
  const sideRaw = asString(raw.side)?.toUpperCase();
  if (!tradeId || !symbol || !price || !size || !time) return null;
  if (sideRaw !== 'BUY' && sideRaw !== 'SELL') return null;
  if (Number.isNaN(Date.parse(time))) return null;
  return {
    tradeId,
    symbol,
    price,
    size,
    side: sideRaw,
    exchangeTime: time,
    receivedAt,
    sequenceNum,
  };
}

export function parseMessage(payload: unknown, receivedAt: string): ParsedMessage {
  if (!isRecord(payload)) return { kind: 'unknown', channel: null };

  if (payload.type === 'error') {
    return { kind: 'error', message: asString(payload.message) ?? 'unknown error' };
  }

  const channel = asString(payload.channel);
  const sequenceNum = typeof payload.sequence_num === 'number' ? payload.sequence_num : -1;

  switch (channel) {
    case 'heartbeats':
      return { kind: 'heartbeat', sequenceNum };
    case 'subscriptions':
      return { kind: 'subscriptions', sequenceNum };
    case 'market_trades': {
      const events = Array.isArray(payload.events) ? payload.events : [];
      const trades: Trade[] = [];
      let skipped = 0;
      let eventType: 'snapshot' | 'update' = 'update';
      for (const event of events) {
        if (!isRecord(event)) continue;
        if (event.type === 'snapshot') eventType = 'snapshot';
        const rawTrades = Array.isArray(event.trades) ? event.trades : [];
        for (const rawTrade of rawTrades) {
          const trade = parseTrade(rawTrade, receivedAt, sequenceNum);
          if (trade) trades.push(trade);
          else skipped += 1;
        }
      }
      return { kind: 'trades', sequenceNum, eventType, trades, skipped };
    }
    default:
      return { kind: 'unknown', channel };
  }
}

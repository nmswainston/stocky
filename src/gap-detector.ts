// Pure sequence continuity check.
//
// Scope, verified against the live feed (2026-08-10 to 2026-08-12):
// Coinbase's sequence_num is CONNECTION scoped, one stream across all
// subscribed channels and products (market_trades + heartbeats over
// BTC-USD, ETH-USD, SOL-USD ran continuous for hours with zero gaps).
// It is not per product; per-product tracking would be wrong here.
// The caller resets its previous value on every reconnect, since a new
// connection starts a new stream. A detected gap means messages were
// lost; the collector marks the in-progress bar bucket incomplete
// rather than only counting the gap.

export type SequenceCheck =
  | { status: 'first' }
  | { status: 'ok' }
  | { status: 'gap'; missed: number }
  | { status: 'regression'; delta: number };

export function checkSequence(previous: number | null, current: number): SequenceCheck {
  if (previous === null) return { status: 'first' };
  const expected = previous + 1;
  if (current === expected) return { status: 'ok' };
  if (current > expected) return { status: 'gap', missed: current - expected };
  return { status: 'regression', delta: expected - current };
}

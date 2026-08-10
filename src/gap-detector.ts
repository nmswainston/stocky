// Pure sequence continuity check.
//
// Assumption to verify: Coinbase's sequence_num is scoped to the whole
// connection (all channels combined) and increments by exactly 1 per
// message. If it is per channel, the caller must keep one previous value
// per channel instead of one overall.

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

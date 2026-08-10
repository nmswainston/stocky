import type { Strategy } from '../types.js';

// The baseline. Signals long on every bar; the engine turns that into a
// single buy at the second bar's open (the first decision still obeys
// next-open execution) and holds to the end, paying entry fees once.

export type BuyAndHoldState = Record<string, never>;

export const buyAndHold: Strategy<BuyAndHoldState> = {
  name: 'buy-and-hold',
  warmupBars: 0,
  decide: () => ({ signal: 'long', state: {} }),
};

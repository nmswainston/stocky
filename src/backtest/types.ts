// Shared vocabulary for the backtester. No implementation here.

export interface ClosedBar {
  symbol: string;
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradeCount: number;
  // False when the underlying data is known or suspected lossy: a
  // WebSocket gap landed in this bucket, the bucket was reconstructed
  // after a crash, or an aggregate is missing source bars. Absent means
  // complete (bars from before this flag existed). Consumers report it;
  // nothing fabricates replacement data.
  complete?: boolean;
  // On aggregated bars: how many source bars actually contributed.
  sourceBars?: number;
}

export type Signal = 'long' | 'flat';

// The only view of history a strategy gets. Oldest first, the just-closed
// decision bar last. Accessors are bounds checked at runtime against a
// limit fixed when the window is created, so a stashed window from an
// earlier bar can never see later bars, casts or not.
export interface BarWindow {
  readonly length: number;
  at(index: number): ClosedBar;
  readonly last: ClosedBar;
  lastN(count: number): readonly ClosedBar[];
}

export interface StrategyDecision<State> {
  signal: Signal;
  state: State;
}

export interface Strategy<State> {
  readonly name: string;
  // Bars required before signals mean anything. The engine forces 'flat'
  // until the window is at least this long and reports the exclusion.
  readonly warmupBars: number;
  decide(window: BarWindow, priorState: State | null): StrategyDecision<State>;
}

export interface BacktestConfig {
  symbol: string;
  initialEquity: string;
  // Fraction of equity deployed on entry, (0, 1]. No leverage, no shorting.
  positionFraction: number;
  takerFeeBps: number;
  // Present for completeness. Every fill in this phase crosses the spread,
  // so maker fees are never charged. Limit orders would change that.
  makerFeeBps: number;
  slippageBps: number;
  // Bar duration fed to the replay, in minutes. Defaults to 1. Metrics
  // need this: annualizing 15 minute bars as if they were 1 minute bars
  // inflates Sharpe by a factor of sqrt(15).
  timeframeMinutes?: number;
  from?: string;
  to?: string;
}

export interface Fill {
  side: 'BUY' | 'SELL';
  executedAtBar: string;
  decidedAtBar: string;
  referenceOpen: string;
  fillPrice: string;
  quantity: string;
  notional: string;
  fee: string;
}

export interface RoundTrip {
  entry: Fill;
  exit: Fill;
  netPnl: string;
  netPnlPct: number;
  holdingBars: number;
}

export interface BacktestResult {
  strategyName: string;
  config: BacktestConfig;
  data: {
    firstBar: string;
    lastBar: string;
    barCount: number;
    missingBars: number;
    // Bars present but marked lossy: sequence gaps, crash-recovered
    // buckets, or aggregates with missing sources. They are replayed
    // like any other bar, but never silently.
    incompleteBars: number;
    warmupBarsExcluded: number;
  };
  performance: {
    finalEquity: string;
    totalReturnPct: number;
    annualizedReturnPct: number;
    sharpeRatio: number | null;
    maxDrawdownPct: number;
    maxDrawdownDuration: { bars: number; from: string; to: string } | null;
  };
  trades: {
    fillCount: number;
    roundTripCount: number;
    winRate: number | null;
    averageWinPct: number | null;
    averageLossPct: number | null;
    openPositionAtEnd: boolean;
    undecidedSignalAtEnd: boolean;
  };
  costs: {
    grossReturnPct: number;
    netReturnPct: number;
    totalFees: string;
    totalSlippage: string;
  };
  equityCurve: ReadonlyArray<{ time: string; equity: string }>;
  fills: readonly Fill[];
  roundTrips: readonly RoundTrip[];
}

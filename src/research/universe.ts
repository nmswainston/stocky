// The wider list that discovery scans each morning for unusual moves,
// volume, news and fresh 8-K filings. About 100 large, heavily traded US
// stocks, roughly the S&P 100. Edit freely, or set
// STOCKY_DISCOVERY_UNIVERSE in .env to replace it (for example with the
// whole S&P 500). Names that stop trading simply drop out: a symbol with
// no recent bars is skipped, never an error.
//
// Left out on purpose: tickers with a dot (BRK.B), which Alpaca and the
// SEC spell differently, and foreign filers that file no 10-Q or 8-K.

export const LARGE_CAP_UNIVERSE = [
  // Technology
  'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM', 'NOW',
  'INTU', 'AMAT', 'MU', 'LRCX', 'KLAC', 'ADI', 'PANW', 'CRWD', 'SNPS', 'CDNS',
  'PLTR', 'ANET', 'MRVL', 'DELL', 'ACN',
  // Communication
  'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR',
  // Consumer
  'MCD', 'SBUX', 'NKE', 'LOW', 'TGT', 'TJX', 'BKNG', 'ABNB', 'UBER', 'KO',
  'PEP', 'PM', 'MO', 'MDLZ', 'CL', 'GM', 'F',
  // Financials
  'BAC', 'WFC', 'C', 'GS', 'MS', 'SCHW', 'AXP', 'BLK', 'SPGI', 'PYPL',
  'COF', 'CB', 'PGR', 'ICE', 'CME',
  // Energy
  'CVX', 'COP', 'SLB', 'EOG',
  // Health care
  'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN', 'GILD', 'BMY', 'ISRG',
  'VRTX', 'REGN', 'MDT', 'CVS', 'CI', 'ELV', 'SYK', 'BSX',
  // Industrials
  'CAT', 'DE', 'GE', 'HON', 'BA', 'LMT', 'RTX', 'UPS', 'UNP', 'ETN',
  'GD', 'NOC',
  // Utilities, real estate, materials
  'NEE', 'DUK', 'SO', 'LIN', 'AMT', 'PLD',
];

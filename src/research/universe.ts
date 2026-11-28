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

// Smaller, lesser-known US names for RESEARCH_UNIVERSE=small or both:
// roughly 200 small and mid caps, curated for liquidity and spread
// across sectors. A point-in-time list (late 2025): names get acquired,
// delisted or outgrow the label, and that is fine, because a symbol
// with no recent bars is skipped, never an error. Same exclusions as
// above: no dotted tickers, no foreign filers.

export const SMALL_CAP_UNIVERSE = [
  // Semiconductors and hardware
  'ACLS', 'AMBA', 'ALGM', 'CRUS', 'DIOD', 'FORM', 'LSCC', 'MTSI', 'ONTO', 'PLAB',
  'POWI', 'RMBS', 'SITM', 'SLAB', 'SMTC', 'SYNA', 'VECO', 'COHU', 'ICHR', 'KLIC',
  'UCTT', 'ACMR',
  // Software and internet
  'AGYS', 'ALRM', 'ASAN', 'BL', 'BOX', 'BRZE', 'DOCN', 'ENV', 'FIVN', 'FRSH',
  'INTA', 'JAMF', 'NCNO', 'PD', 'PRGS', 'QLYS', 'RPD', 'SPSC', 'SPT', 'TENB',
  'WK', 'CWAN', 'ZD', 'YELP', 'TRIP', 'UPWK', 'CARG', 'CARS', 'EB',
  'QNST', 'BMBL', 'GRPN', 'REAL', 'LZ',
  // Consumer and restaurants
  'AEO', 'ANF', 'BJRI', 'BOOT', 'CAKE', 'CBRL', 'COLM', 'CROX', 'DENN', 'DIN',
  'GIII', 'JACK', 'KTB', 'OXM', 'PLAY', 'SHAK', 'SG', 'SONO', 'LESL', 'OLPX',
  'PTON', 'WWW', 'YETI', 'WING',
  // Industrials
  'AAON', 'ABM', 'AGX', 'ALG', 'ATKR', 'AZZ', 'CSWI', 'EPAC', 'FELE', 'GVA',
  'HLIO', 'IESC', 'KAI', 'MWA', 'NPO', 'PRIM', 'ROAD', 'STRL', 'TPC', 'POWL',
  'SPXC', 'WTS', 'MLI', 'MYRG',
  // Financials: banks, insurers, fintech
  'ABCB', 'AUB', 'BANF', 'CADE', 'COLB', 'CVBF', 'FFIN', 'FHB', 'GBCI', 'HOMB',
  'HWC', 'ONB', 'OZK', 'SFNC', 'SSB', 'TBBK', 'WSFS', 'AX', 'ENVA', 'LC',
  'NAVI', 'TREE', 'VIRT', 'BGC', 'PJT', 'PIPR', 'HLI', 'PLMR', 'THG', 'AMSF',
  'TRUP', 'GSHD', 'ESNT', 'NMIH', 'RDN', 'UPST',
  // Health care: biotech, devices, services
  'ACAD', 'AMPH', 'ARWR', 'CORT', 'CPRX', 'DVAX', 'FOLD', 'IRWD', 'LGND', 'MYGN',
  'PCRX', 'PTCT', 'SUPN', 'VCEL', 'XENE', 'OMCL', 'NEOG', 'PGNY', 'ADUS', 'PNTG',
  'LFST', 'EVH', 'RDNT', 'SDGR', 'TWST', 'PACB', 'CDNA', 'ATEC', 'SIBN',
  'BLFS', 'TNDM', 'LNTH', 'GKOS', 'PRCT', 'KRYS', 'AXSM',
  // Energy and materials
  'AROC', 'CIVI', 'CRC', 'CRK', 'GPOR', 'KOS', 'LBRT', 'MGY', 'MUR', 'NOG',
  'OII', 'PTEN', 'RIG', 'SM', 'TALO', 'WHD', 'WKC', 'BTU', 'HCC', 'ASH',
  'AVNT', 'CBT', 'HWKN', 'IOSP', 'KALU', 'TROX', 'WOR', 'SLVM', 'ESI', 'SXT',
  // REITs and utilities
  'AHH', 'APLE', 'BNL', 'DEA', 'GTY', 'IIPR', 'LXP', 'PECO', 'SKT', 'UE',
  'NWE', 'OGS', 'POR', 'AVA', 'BKH', 'MGEE', 'NJR', 'SWX', 'SR',
];

# stocky

A crypto trading bot built as a learning project, in deliberate phases.
Each phase earns the next one. There is no live trading and no order
placement anywhere in this codebase yet, on purpose.

Current state: collects Coinbase market data continuously, charts it,
backtests strategies against it, and paper trades them live with
fictional money. Real orders are phase 5 and gated on evidence.

## Architecture

```
Coinbase WebSocket (market_trades, heartbeats)
        |
   collector (npm run dev)
        |  trades -> DuckDB, exported daily to partitioned Parquet
        |  1m OHLCV bars -> DuckDB bars_1m
        |  read-only HTTP API + dashboard on 127.0.0.1:8787
        |
        +---> dashboard (browser)   charts, status, backtests, paper sessions
        +---> backtester (npm run backtest)   reads bars over HTTP or file
        +---> paper trader (npm run paper)    polls bars, trades fictional money
```

Three processes, one writer. DuckDB allows a single writing process, so
the collector owns the database and everything else reads through its
HTTP API. The backtester and paper trader never touch the file while
the collector runs.

## Commands

| Command | What it does |
|---|---|
| `npm run up` | Everything: collector plus every existing paper session, restarts on crash, logs to `data/logs/` |
| `npm run dev` | Collector alone, logs to the terminal |
| `npm run backtest -- --strategy sma --fast 5 --slow 20` | Backtest against collected bars (`--timeframe 15` for 15m bars, `--save` for the dashboard, `--json` for full results) |
| `npm run paper -- --strategy sma --fast 5 --slow 20` | Create or resume a paper trading session (`--timeframe 15` to trade 15m bars) |
| `npm run reconcile -- --id <session-id>` | Prove a paper session and a backtest over the same bars are identical |
| `npm run digest -- --date YYYY-MM-DD` | Write the markdown daily digest (defaults to yesterday UTC; a systemd timer runs it nightly) |
| `npm run walkforward -- --strategy sma --fast 5 --slow 20 --timeframe 60 --folds 4` | Test the same fixed strategy independently across contiguous folds of history; repeatability, not curve fit |
| `npm run research` | Stock research digest: Claude writes a cited thesis on the day's most active watchlist names. Research only, no orders (`--dry-run` to skip Claude, `--symbols AAPL,MSFT --limit 2` to narrow it) |
| `npm run research:backtest -- --from 2023-01-01 --every 5 --hold 20 --top 5` | Replay past prices: does the screen find movers, and does a plain rule score beat SPY? No Claude calls |
| `npm run research:scorecard -- --horizon 20` | Grade saved theses against what happened next, by score, versus SPY |
| `npm test` | Vitest suite |
| `npm run typecheck` | tsc, no emit |

Dashboard: http://127.0.0.1:8787 while the collector runs.

A styled, printable version of this command table lives at
[docs/commands.html](docs/commands.html); double-click it to open in a
browser.

## Always-on operation

`npm run up` starts the collector and a paper runner for every session
file in `data/paper/`, restarts children with backoff when they die,
and writes their output to `data/logs/<name>.log`. Create new paper
sessions with `npm run paper` once; the supervisor adopts them on its
next start.

To start everything automatically at logon, run once from the repo:

```
powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1
```

Remove it again with the same script plus `-Remove`.

### Linux / Raspberry Pi

A Pi 3 B+ or later handles collection comfortably; use 64-bit
Raspberry Pi OS **Lite** (Node and DuckDB need ARM64, and the desktop
would waste the Pi 3's 1 GB of RAM). Prefer a USB SSD or
high-endurance card for `data/` — continuous writes wear cheap
microSD cards out.

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/nmswainston/stocky.git ~/stocky
cd ~/stocky && npm ci
sudo cp scripts/stocky.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stocky
```

The unit sets `STOCKY_HOST=0.0.0.0` so the dashboard is reachable at
`http://<pi-address>:8787` from the LAN (the API is read-only; remove
that line for loopback-only plus an SSH tunnel). Logs:
`journalctl -u stocky -f`. On a 1 GB Pi keep it to the collector plus
a couple of paper sessions, and run backtests from another machine
against the Pi's API.

### Docker (self-hosted server)

On a bigger Linux box, run Stocky in Docker instead. The always-on
container runs the supervisor, a separate job runs the weekday stock
research, and `data/` plus `.env` stay on the host:

```
cp .env.example .env   # fill in keys, chmod 600
docker compose up -d --build
docker compose --profile jobs run --rm research --dry-run
```

The dashboard is published on loopback only; use Tailscale to read it
on a phone. Full steps, the systemd timer, moving data over from a Pi,
and backups are in [docs/server.md](docs/server.md).

## Data layout

```
data/
  stocky.duckdb          current-day trades + all 1m bars (single writer: collector)
  parquet/trades/        completed days, hive partitioned by date and symbol
  backtests/             saved backtest results (JSON, rendered by the dashboard)
  paper/                 paper session state files (JSON, atomic writes)
  logs/                  supervisor child logs
  digests/               crypto digests and research-YYYY-MM-DD.md stock digests
  research/YYYY-MM-DD/   theses, snapshots, prompts and cost for each research run
  research/cache/edgar/  SEC responses, reused for 20 hours
```

## Stock research (research only)

The first step toward stocks. Every weekday morning it reads prices and
news from Alpaca's free market data feed and filings plus quarterly
figures from SEC EDGAR for a watchlist, screens for the names where
something happened, and asks Claude for a short thesis on those, scored
from -5 to +5. It writes a markdown digest that shows up in the
dashboard's Daily digest picker. Nothing here can place an order:
`src/research/no-orders.test.ts` fails the build if a trading endpoint
appears in the module.

```
Alpaca market data (bars, news) + SEC EDGAR (filings, XBRL facts)
        |
   collect: daily bars for the watchlist + SPY, 7 days of news, 120 days of filings
        |
   screen: plain math ranks unusual moves, volume, news and fresh 10-Q/10-K filings
        |
   research: Claude (no tools) reads one snapshot, returns JSON with cited points
        |
   check: code drops uncited points and made-up source ids, zeroes unsupported scores
        |
   digest: data/digests/research-YYYY-MM-DD.md (+ everything behind it in data/research/)
```

The rules that keep it honest:

- **Cite or drop.** Every fact in a snapshot has a source id. A thesis
  point that cites nothing real is removed, and the digest says so.
- **No lookahead.** Nothing stamped at or after the run time reaches the
  prompt, and filings use the first report of each quarter, not later
  restatements.
- **Hard spend cap.** Before each call the worst case (whole prompt plus
  every allowed output token) is checked against the daily budget.
- **Traceable.** Each run saves the exact prompts, snapshots and token
  counts, so any score can be traced back to what it was based on.

### Setup

1. Copy `.env.example` to `.env` and fill in the Alpaca keys (from the
   Paper trading dashboard; only market data is used), an Anthropic API
   key, and an SEC user agent with your email. Needs Node 20.12 or newer
   for the built-in `.env` loader.
2. Try it without spending anything: `npm run research -- --dry-run`.
   It fetches the data, builds the prompts into
   `data/research/<date>/prompts/`, and estimates tokens.
3. One real stock: `npm run research -- --symbols AAPL --limit 1`
   (about 4 cents on Claude Sonnet 5.5).
4. Daily: install `scripts/stocky-research.service` and `.timer` (runs
   weekdays at 12:30 UTC, 5:30 AM in Phoenix).

### Backtest and scorecard

Two honest ways to check the research, neither of which spends on Claude:

- `npm run research:backtest` replays past daily bars. It tests the parts
  that are plain rules: whether the screen points at stocks that then
  move, and whether a simple momentum score (trend versus SPY plus
  distance from the 50 day average) beats SPY after 10 bps a round trip.
  That score is the bar Claude has to clear.
- `npm run research:scorecard` grades saved theses: the stock's return
  minus SPY's over the next 20 sessions, grouped by score. Positive
  theses should beat SPY and negative ones should trail it.

Claude itself is not backtested on purpose. A model shown a 2024 snapshot
already knows how 2024 ended, so its old theses look smarter than they
were. The real test is the live digests, graded forward. `npm run
research -- --as-of 2025-03-03 --limit 3` exists as a cheap smoke test of
the pipeline on past dates; those runs are saved under
`data/research/as-of/`, marked, and reported separately.

The watchlist is today's large caps, picked with hindsight
(survivorship bias), so every backtest on it flatters the strategy.

Defaults: 20 large US stocks, 8 researched a day, Claude Sonnet 5.5,
$0.75 a day cap (roughly $5 to $15 a month in practice). All settings
are in `src/research/config.ts` and can be overridden in `.env`.

## Design rules that keep the numbers honest

- **No look-ahead, structurally.** A strategy only ever sees closed bars
  up to the current one through a bounds-checked window, and a decision
  on bar N can only fill at bar N+1's open. The replay loop's shape
  (settle, mark, decide, queue) enforces this; adversarial tests pin it.
- **One fill implementation.** Backtests and paper trading share the
  exact sizing, fee, slippage, and rounding code. A test proves a paper
  session folded over the same bars is bit-identical to a backtest, and
  `npm run reconcile` demonstrates it on live data.
- **Exact money.** Prices and sizes are decimal strings end to end,
  accounted in scaled bigints. Floats appear only in summary ratios.
- **Fees and slippage always against the trader.** 60 bps taker on the
  post-slippage notional, both sides of every round trip. Gross vs net
  is reported separately so friction is never hidden.
- **Gaps are reported, never repaired.** Missing minutes stay missing
  in charts, backtests, aggregations, and paper sessions.
- **Purity is enforced, not assumed.** The engine can run every
  strategy decision twice on cloned state and reject nondeterminism or
  state mutation; the paper trader always does.

## Phases

1. **Collector** (done): WebSocket ingestion, reconnect with backoff,
   sequence gap detection, DuckDB plus Parquet storage.
2. **Backtester** (done): strategy interface, replay engine, fees,
   slippage, metrics, Vitest.
3. **Dashboard** (done): candlesticks, live status, backtest and paper
   visualization, served by the collector.
4. **Paper trading** (done): live bars, fictional fills, baseline
   comparison, crash recovery by replay.
5. **Live orders** (not started): gated on a strategy beating
   buy-and-hold in paper for weeks. Key custody, idempotent orders,
   reconciliation, kill switch. Deliberately last.

## Dependencies

10 of a self-imposed budget of 12: ws, @duckdb/node-api, pino,
lightweight-charts, @anthropic-ai/sdk, and dev: typescript, tsx,
vitest, @types/node, @types/ws. Alpaca and SEC EDGAR are called with
plain fetch, and Claude's JSON is checked by hand rather than with a
schema library, to stay inside the budget.

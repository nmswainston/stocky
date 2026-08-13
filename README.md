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

## Data layout

```
data/
  stocky.duckdb          current-day trades + all 1m bars (single writer: collector)
  parquet/trades/        completed days, hive partitioned by date and symbol
  backtests/             saved backtest results (JSON, rendered by the dashboard)
  paper/                 paper session state files (JSON, atomic writes)
  logs/                  supervisor child logs
```

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

9 of a self-imposed budget of 12: ws, @duckdb/node-api, pino,
lightweight-charts, and dev: typescript, tsx, vitest, @types/node,
@types/ws.

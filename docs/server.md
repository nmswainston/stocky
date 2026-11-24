# Running Stocky on your AI server

Stocky runs in Docker: one always-on container (the crypto collector,
paper sessions, dashboard and API) and one short job each weekday
morning (the stock research digest), started by a systemd timer on the
host. Everything it writes lives in `./data`, and secrets live in `.env`.
Neither is ever baked into the image.

## What you need on the server

- Linux with Docker Engine and the Compose plugin (`docker compose version` works).
- About 2 GB of disk to start; crypto trades grow `data/` by roughly
  tens of MB a week.
- Tailscale, if you want to read the dashboard on your phone away from home.

## First setup

```sh
sudo git clone https://github.com/nmswainston/stocky /opt/stocky
sudo chown -R "$USER" /opt/stocky
cd /opt/stocky

cp .env.example .env        # fill in the keys (see the README, Stock research)
chmod 600 .env
mkdir -p data

# The container runs as your user, so files in data/ stay yours.
echo "STOCKY_UID=$(id -u)" >> .env
echo "STOCKY_GID=$(id -g)" >> .env

docker compose up -d --build          # collector, paper sessions, dashboard
docker compose --profile jobs run --rm research --dry-run   # data check, no Claude cost
```

Then install the weekday timer:

```sh
sudo cp scripts/docker/stocky-research.service scripts/docker/stocky-research.timer /etc/systemd/system/
# edit WorkingDirectory in the .service if you cloned somewhere other than /opt/stocky
sudo systemctl daemon-reload
sudo systemctl enable --now stocky-research.timer
systemctl list-timers stocky-research.timer   # shows the next run
```

## Everyday commands

| Command | What it does |
|---|---|
| `docker compose ps` | Is the supervisor up and healthy? |
| `docker compose logs -f stocky` | Supervisor output (child logs are in `data/logs/`) |
| `docker compose --profile jobs run --rm research` | Run today's research digest now |
| `journalctl -u stocky-research.service` | What the timer's last run printed |
| `git pull && docker compose up -d --build` | Update to the latest code |
| `docker compose down` | Stop everything (data stays in `data/`) |

## Reading it on your phone

The dashboard is published on `127.0.0.1:8787` only, so nothing on your
home network can reach it by accident. To read it on your phone, put the
server and phone on Tailscale and run once on the server:

```sh
sudo tailscale serve --bg 8787
```

Then open `https://<server-name>.<your-tailnet>.ts.net` on your phone.
Only devices signed in to your tailnet can see it. Research digests show
in the Daily digest picker.

## What changes from the Raspberry Pi

| | Raspberry Pi | AI server |
|---|---|---|
| How it runs | Bare Node with `scripts/stocky.service` | Docker, `docker-compose.yml` |
| Research timer | `scripts/stocky-research.service` | `scripts/docker/stocky-research.service` |
| Storage | SD card: needs a high-endurance card, wears out | SSD: no wear concern at this write rate |
| Memory | 1 GB: collector plus a couple of paper sessions | Plenty: run backtests on the same box |
| Dashboard access | `STOCKY_HOST=0.0.0.0` on the LAN | Loopback plus Tailscale |
| CPU | arm64 | Usually x86; the image builds on both |

Moving over from the Pi:

1. On the Pi: `sudo systemctl stop stocky stocky-digest.timer`. DuckDB
   allows one writer, so the Pi must be stopped before you copy.
2. Copy the data: `rsync -a pi@<pi-address>:/home/pi/stocky/data/ /opt/stocky/data/`
3. On the server: `docker compose up -d --build`, then check the dashboard
   shows your old bars and paper sessions.
4. Once it has run cleanly for a day: `sudo systemctl disable stocky stocky-digest.timer` on the Pi.

The crypto digest's own timer (`stocky-digest`) can come along later the
same way if you still want it; the dashboard keeps working without it.

## Backups

Everything worth keeping is in `data/`. A nightly copy is enough:

```sh
# crontab -e on the server
15 3 * * * rsync -a --delete /opt/stocky/data/ /path/to/backup/stocky-data/
```

Back up `.env` separately and privately; it holds your API keys.

## Security notes

- `.env` is git-ignored and excluded from the image by `.dockerignore`.
  Only the research job receives it; the collector needs no keys.
- The containers run as your user, not root.
- Nothing in the image can place an order. The research module has a
  test that fails the build if a trading endpoint appears.

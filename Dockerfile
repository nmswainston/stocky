# Stocky on a self-hosted server. One image runs both jobs:
#   stocky    the always-on supervisor (crypto collector, paper sessions,
#             dashboard and read-only API on port 8787)
#   research  the weekday stock research digest, run once by a timer
# See docs/server.md. Secrets come from .env at run time, never the image.

# Debian, not Alpine: DuckDB's prebuilt Node binding needs glibc. The
# official image is multi-arch, so the same file builds on x86 and arm64.
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first so code changes reuse this layer. Dev dependencies
# are kept on purpose: Stocky runs TypeScript through tsx, like on the Pi.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY docs ./docs

# Everything Stocky writes lives under /app/data, mounted from the host.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV STOCKY_HOST=0.0.0.0 \
    STOCKY_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/supervisor.ts"]

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

// One command to run everything: the collector plus a paper runner for
// every session that exists in data/paper. Children that die are
// restarted with backoff; children that stay up have their backoff
// forgiven. Logs go to data/logs/<name>.log instead of a terminal.
//
// Creating a NEW paper session is still `npm run paper -- ...` once;
// the supervisor picks it up on its next start.
//
// Shutdown note: on Windows, killing a child is abrupt (no signal
// handlers run). That is acceptable by design: the collector loses at
// most one flush interval and reseeds on restart, and paper sessions
// persist after every processed bar and resume by replay.

const log = logger.child({ module: 'supervisor' });

const TSX_CLI = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const LOG_DIRECTORY = path.resolve('data', 'logs');
mkdirSync(LOG_DIRECTORY, { recursive: true });

interface ManagedProcess {
  name: string;
  scriptArgs: string[];
  child: ChildProcess | null;
  consecutiveFailures: number;
  startedAtMs: number;
}

function paperSessionIds(): string[] {
  try {
    return readdirSync(path.resolve('data', 'paper'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

const managed: ManagedProcess[] = [
  { name: 'collector', scriptArgs: ['src/index.ts'], child: null, consecutiveFailures: 0, startedAtMs: 0 },
  ...paperSessionIds().map((id) => ({
    name: `paper-${id}`,
    scriptArgs: ['src/paper/cli.ts', '--id', id],
    child: null,
    consecutiveFailures: 0,
    startedAtMs: 0,
  })),
];

let stopping = false;

function start(processInfo: ManagedProcess): void {
  if (stopping) return;
  const logStream = createWriteStream(path.join(LOG_DIRECTORY, `${processInfo.name}.log`), {
    flags: 'a',
  });
  const child = spawn(process.execPath, [TSX_CLI, ...processInfo.scriptArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => logStream.write(chunk));
  child.stderr?.on('data', (chunk) => logStream.write(chunk));
  processInfo.child = child;
  processInfo.startedAtMs = Date.now();
  log.info({ name: processInfo.name, pid: child.pid }, 'started');

  child.on('exit', (code) => {
    logStream.end();
    processInfo.child = null;
    if (stopping) return;
    const aliveMs = Date.now() - processInfo.startedAtMs;
    // A minute of stable running forgives past failures.
    processInfo.consecutiveFailures = aliveMs > 60_000 ? 0 : processInfo.consecutiveFailures + 1;
    const delayMs = Math.min(60_000, 5_000 * 2 ** processInfo.consecutiveFailures);
    log.warn({ name: processInfo.name, code, delayMs }, 'exited, will restart');
    setTimeout(() => start(processInfo), delayMs);
  });
}

const [collector, ...paperRunners] = managed;
start(collector as ManagedProcess);
// Paper runners start after the collector has had time to open its API,
// so their first history fetch usually succeeds on the first try.
setTimeout(() => {
  for (const runner of paperRunners) start(runner);
}, 8_000);

log.info(
  { collector: 1, paperSessions: paperRunners.length, logDirectory: LOG_DIRECTORY },
  'supervisor running',
);

function shutdown(): void {
  stopping = true;
  log.info('supervisor stopping, killing children');
  for (const processInfo of managed) processInfo.child?.kill();
  setTimeout(() => process.exit(0), 1_000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

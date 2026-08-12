import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StrategySpec } from '../backtest/strategy-factory.js';
import type { SerializedBook } from './session.js';

// Atomic persistence for paper sessions: write to a temp file, then
// rename over the old one, so a crash mid-save leaves the previous
// consistent state instead of a torn file.

export interface PaperConfig {
  id: string;
  symbol: string;
  strategy: StrategySpec;
  strategyName: string;
  initialEquity: string;
  positionFraction: number;
  takerFeeBps: number;
  makerFeeBps: number;
  slippageBps: number;
  // Bar duration the strategy trades on, in minutes. Absent in state
  // files from before timeframes existed, which ran on 1m bars.
  timeframeMinutes?: number;
  startedAt: string;
}

export interface PaperStateFile {
  version: 1;
  config: PaperConfig;
  lastProcessedBar: string | null;
  // Gaps between processed bars, counted at the session's timeframe:
  // collector outages and paper trader downtime look identical here,
  // and both belong on the record.
  gaps: Array<{ from: string; to: string; missedBars: number }>;
  main: SerializedBook;
  baseline: SerializedBook;
  updatedAt: string;
}

export async function loadStateFile(
  directory: string,
  id: string,
): Promise<PaperStateFile | null> {
  try {
    const raw = await readFile(path.join(directory, `${id}.json`), 'utf8');
    return JSON.parse(raw) as PaperStateFile;
  } catch {
    return null;
  }
}

export async function saveStateFile(directory: string, state: PaperStateFile): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${state.config.id}.json`);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, target);
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BacktestResult } from './types.js';

// Saved backtests are plain JSON files the dashboard lists and renders.
// The id doubles as the filename and stays URL and filesystem safe.

export async function saveResult(
  result: BacktestResult,
  directory = path.join('data', 'backtests'),
): Promise<string> {
  const savedAt = new Date().toISOString();
  const stamp = savedAt.replace(/[:.]/g, '-').slice(0, 19);
  const slug = `${result.strategyName}-${result.config.symbol}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const id = `${stamp}_${slug}`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${id}.json`),
    JSON.stringify({ id, savedAt, result }, null, 2),
  );
  return id;
}

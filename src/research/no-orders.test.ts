import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase 1 is research only. This test fails the build if anything under
// src/research gains a way to reach a broker's trading API. Lifting it
// is a deliberate phase 2 decision, made in code review, not by drift.

const here = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [
  /paper-api\.alpaca\.markets/i,
  /api\.alpaca\.markets/i, // trading host; market data lives on data.alpaca.markets
  /\/v2\/orders/i,
  /\/v2\/positions/i,
  /place_?order|submit_?order|create_?order/i,
  /robinhood/i,
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') && entry.name !== 'no-orders.test.ts') files.push(full);
  }
  return files;
}

describe('research module', () => {
  it('has no path to a trading or order endpoint', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(here)) {
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        // data.alpaca.markets contains "alpaca.markets" but not "api.alpaca.markets".
        if (pattern.test(text)) offenders.push(`${path.relative(here, file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives the model no tools', async () => {
    const agent = await readFile(path.join(here, 'agent.ts'), 'utf8');
    expect(agent).not.toMatch(/\btools\s*:/);
  });
});

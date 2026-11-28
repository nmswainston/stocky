import { afterEach, describe, expect, it } from 'vitest';
import { researchConfig } from './config.js';
import { LARGE_CAP_UNIVERSE, SMALL_CAP_UNIVERSE } from './universe.js';

const TOUCHED = ['RESEARCH_UNIVERSE', 'STOCKY_DISCOVERY_UNIVERSE'];

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name];
});

describe('researchConfig universe modes', () => {
  it('defaults to the large-cap universe and its thresholds', () => {
    const config = researchConfig();
    expect(config.universeMode).toBe('large');
    expect(config.discovery.universe).toEqual(LARGE_CAP_UNIVERSE);
    expect(config.discovery.minPrice).toBe(10);
    expect(config.discovery.minDollarVolume).toBe(2_000_000);
  });

  it('small mode swaps the list and loosens the liquidity floor', () => {
    process.env.RESEARCH_UNIVERSE = 'small';
    const config = researchConfig();
    expect(config.universeMode).toBe('small');
    expect(config.discovery.universe).toEqual(SMALL_CAP_UNIVERSE);
    expect(config.discovery.minPrice).toBe(5);
    expect(config.discovery.minDollarVolume).toBe(500_000);
  });

  it('both mode scans the union without duplicates', () => {
    process.env.RESEARCH_UNIVERSE = 'both';
    const config = researchConfig();
    const union = new Set([...LARGE_CAP_UNIVERSE, ...SMALL_CAP_UNIVERSE]);
    expect(config.discovery.universe).toHaveLength(union.size);
    expect(config.discovery.minPrice).toBe(5);
  });

  it('an explicit STOCKY_DISCOVERY_UNIVERSE list wins over the mode', () => {
    process.env.RESEARCH_UNIVERSE = 'small';
    process.env.STOCKY_DISCOVERY_UNIVERSE = 'orcl, crm';
    expect(researchConfig().discovery.universe).toEqual(['ORCL', 'CRM']);
  });

  it('rejects an unknown mode', () => {
    process.env.RESEARCH_UNIVERSE = 'medium';
    expect(() => researchConfig()).toThrow(/RESEARCH_UNIVERSE/);
  });
});

describe('SMALL_CAP_UNIVERSE hygiene', () => {
  it('holds valid, unique tickers that do not repeat the large list', () => {
    expect(SMALL_CAP_UNIVERSE.length).toBeGreaterThan(150);
    expect(new Set(SMALL_CAP_UNIVERSE).size).toBe(SMALL_CAP_UNIVERSE.length);
    const large = new Set(LARGE_CAP_UNIVERSE);
    for (const symbol of SMALL_CAP_UNIVERSE) {
      expect(symbol).toMatch(/^[A-Z]{1,5}$/); // no dots, no lowercase
      expect(large.has(symbol)).toBe(false);
    }
  });
});

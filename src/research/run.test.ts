import { describe, expect, it } from 'vitest';
import type { ThesisReply, ThesisWriter } from './agent.js';
import { researchConfig } from './config.js';
import { renderDigest } from './render.js';
import { marketDateOf, runResearch, type RunSources } from './run.js';
import { dailyBars, newsItem, rampCloses } from './testing/fixtures.js';
import type { DailyBar } from './types.js';

const NOW = new Date('2026-09-01T13:00:00.000Z');

function sources(barsBySymbol: Record<string, DailyBar[]>): RunSources & { newsCalls: string[] } {
  const newsCalls: string[] = [];
  return {
    newsCalls,
    async dailyBars(symbols) {
      return new Map(symbols.map((symbol) => [symbol, barsBySymbol[symbol] ?? []]));
    },
    async news(symbol) {
      newsCalls.push(symbol);
      return [
        newsItem(`${symbol}-old`, '2026-08-28T10:00:00Z'),
        newsItem(`${symbol}-new`, '2026-08-31T22:00:00Z'),
        // Stamped after the run started: must never reach the prompt.
        newsItem(`${symbol}-future`, '2026-09-02T10:00:00Z'),
      ];
    },
    async company(symbol) {
      return symbol === 'NOSEC' ? null : { cik: 1, title: `${symbol} Inc.` };
    },
    async filings() {
      return [];
    },
    async facts() {
      return [];
    },
  };
}

function writer(score: number, usage = { input_tokens: 4_000, output_tokens: 1_500 }) {
  const prompts: string[] = [];
  const models: (string | undefined)[] = [];
  const impl: ThesisWriter = {
    async write(prompt, model): Promise<ThesisReply> {
      prompts.push(prompt);
      models.push(model);
      const symbol = /Write the thesis for (\S+)\./.exec(prompt)?.[1] ?? '';
      return {
        json: {
          score,
          confidence: 'medium',
          summary: `About ${symbol}.`,
          bull: [{ point: 'Price is rising.', sources: [`price:${symbol}`] }],
          bear: [{ point: 'Old headline.', sources: [`news:${symbol}-old`] }],
          watch_for: ['earnings'],
        },
        usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { impl, prompts, models };
}

const bars: Record<string, DailyBar[]> = {
  SPY: dailyBars(rampCloses(80, 400, 1)),
  // Big move: should be picked first.
  JUMP: dailyBars([...rampCloses(75, 100, 0.1), 110, 120, 130, 140, 150]),
  // Ordinary noise around a flat price: nothing unusual to research.
  CALM: dailyBars(Array.from({ length: 80 }, (_, index) => (index % 2 === 0 ? 50 : 51))),
  NOSEC: dailyBars(Array.from({ length: 80 }, (_, index) => (index % 2 === 0 ? 20 : 20.4))),
};

function config(overrides: Partial<ReturnType<typeof researchConfig>> = {}) {
  return { ...researchConfig(), watchlist: ['JUMP', 'CALM', 'NOSEC'], ...overrides };
}

describe('runResearch', () => {
  it('uses the New York market date', () => {
    expect(marketDateOf(new Date('2026-09-02T02:00:00Z'))).toBe('2026-09-01');
  });

  it('researches the most interesting names first, up to the limit', async () => {
    const { impl, prompts } = writer(2);
    const result = await runResearch(config(), sources(bars), impl, { now: NOW, limit: 1 });
    expect(result.theses.map((thesis) => thesis.symbol)).toEqual(['JUMP']);
    expect(prompts).toHaveLength(1);
    expect(result.rows.find((row) => row.symbol === 'JUMP')?.researched).toBe(true);
    expect(result.theses[0]?.verified).toBe(true);
  });

  it('never shows the model anything stamped after the run started', async () => {
    const { impl, prompts } = writer(1);
    await runResearch(config(), sources(bars), impl, { now: NOW, limit: 3 });
    for (const prompt of prompts) expect(prompt).not.toContain('-future');
  });

  it('stops calling Claude once the daily budget would be crossed', async () => {
    const { impl, prompts } = writer(1);
    // Worst case per call on Sonnet is about $0.06 of output alone.
    const result = await runResearch(config({ dailyBudgetUsd: 0.08 }), sources(bars), impl, { now: NOW, limit: 3 });
    expect(prompts.length).toBe(1);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped[0]?.reason).toContain('budget');
    expect(result.costUsd).toBeLessThanOrEqual(0.08);
  });

  it('dry run builds prompts and calls nothing', async () => {
    const result = await runResearch(config(), sources(bars), null, { now: NOW, limit: 2 });
    expect(result.dryRun).toBe(true);
    expect(result.theses).toEqual([]);
    expect(result.prompts).toHaveLength(2);
    expect(result.costUsd).toBe(0);
  });

  it('routes picks past premiumPerDay to the budget model and records it', async () => {
    const { impl, models } = writer(1);
    const result = await runResearch(
      config({ budgetModel: 'claude-haiku-5-5', premiumPerDay: 1 }),
      sources(bars),
      impl,
      { now: NOW, limit: 3 },
    );
    expect(models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(result.theses.map((thesis) => thesis.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-haiku-5-5',
    ]);
    expect(result.budgetModel).toBe('claude-haiku-5-5');
  });

  it('uses the premium model for every pick when no budget model is set', async () => {
    const { impl, models } = writer(1);
    await runResearch(config(), sources(bars), impl, { now: NOW, limit: 2 });
    expect(models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });

  it('feeds the prior thesis into the prompt, and only for its symbol', async () => {
    const { impl, prompts } = writer(2);
    const priorTheses = new Map([
      ['JUMP', { asOf: '2026-08-25T12:30:00.000Z', score: 3, confidence: 'medium' as const, summary: 'Prior view.', watchFor: ['earnings'] }],
    ]);
    await runResearch(config(), sources(bars), impl, { now: NOW, limit: 2, priorTheses });
    const jump = prompts.find((prompt) => prompt.includes('Write the thesis for JUMP.'));
    expect(jump).toContain('prior_thesis');
    expect(jump).toContain('Prior view.');
    expect(jump).toContain('stock_return_since');
    for (const other of prompts.filter((prompt) => prompt !== jump)) {
      expect(other).not.toContain('prior_thesis');
    }
  });

  it('records data problems instead of failing the run', async () => {
    const broken = sources(bars);
    broken.news = async () => {
      throw new Error('feed down');
    };
    const result = await runResearch(config(), broken, null, { now: NOW });
    expect(result.rows.find((row) => row.symbol === 'CALM')?.dataProblems.join(' ')).toContain('feed down');
    expect(result.rows.find((row) => row.symbol === 'NOSEC')?.dataProblems.join(' ')).toContain('SEC ticker list');
  });

  it('renders a digest with citations and the cost line', async () => {
    const { impl } = writer(3);
    const result = await runResearch(config(), sources(bars), impl, { now: NOW, limit: 1 });
    const digest = renderDigest(result);
    expect(digest).toContain('# Stock research 2026-09-01');
    expect(digest).toContain('### JUMP (JUMP Inc.): +3, medium confidence');
    expect(digest).toContain('- Price is rising. [1]');
    expect(digest).toContain('https://example.com/JUMP-old');
    expect(digest).toContain('No orders were placed');
    expect(digest).toMatch(/\$0\.0\d\d of a \$0\.75 daily cap/);
  });
});

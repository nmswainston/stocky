import { describe, expect, it } from 'vitest';
import { pushMessage, sendPush } from './notify.js';

const base = { marketDate: '2026-11-27', costUsd: 0.143, budgetUsd: 0.75 };

describe('pushMessage', () => {
  it('lists theses best first with score, confidence and new-find mark', () => {
    const message = pushMessage({
      ...base,
      theses: [
        { symbol: 'T', score: 1, confidence: 'low' },
        { symbol: 'LOW', score: 3, confidence: 'medium' },
        { symbol: 'NVDA', score: -2, confidence: 'high' },
      ],
      rows: [
        { symbol: 'LOW', discovered: true },
        { symbol: 'T', discovered: false },
        { symbol: 'NVDA', discovered: false },
      ],
    });
    expect(message.title).toBe('Stock research 2026-11-27');
    expect(message.body.split('\n')).toEqual([
      'LOW +3 (medium, new find)',
      'T +1 (low)',
      'NVDA -2 (high)',
      '$0.14 of $0.75 spent',
    ]);
  });

  it('says so when there are no theses', () => {
    const message = pushMessage({ ...base, theses: [], rows: [] });
    expect(message.body).toContain('No theses today.');
  });
});

describe('sendPush', () => {
  it('posts the body with Title and Click headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response('ok');
    }) as typeof fetch;
    await sendPush('https://ntfy.example/stocky', { title: 'Hi', body: 'LOW +3' }, {
      clickUrl: 'https://pi.example/research.html',
      fetcher,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ntfy.example/stocky');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('LOW +3');
    expect(calls[0]?.init.headers).toEqual({ Title: 'Hi', Click: 'https://pi.example/research.html' });
  });

  it('does nothing without a URL and swallows send errors', async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error('offline');
    }) as typeof fetch;
    await sendPush(null, { title: 'x', body: 'y' }, { fetcher });
    expect(called).toBe(false);
    const lines: string[] = [];
    await expect(
      sendPush('https://ntfy.example/stocky', { title: 'x', body: 'y' }, { fetcher, log: (line) => lines.push(line) }),
    ).resolves.toBeUndefined();
    expect(lines[0]).toContain('offline');
  });
});
